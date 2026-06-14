import { createId, nowIso, type JobStatus, type JobType } from "@minutesbot/shared";
import type { JobRow } from "./schema";

export type CreateJobInput = {
  type: JobType;
  idempotencyKey: string;
  ownerType?: string | null;
  ownerId?: string | null;
  nextRunAt: string;
  maxAttempts?: number;
  /** Small JSON-serializable metadata. Never artifact content. */
  payload?: Record<string, unknown> | null;
};

/**
 * Inserts a durable job. Returns null when a job with the same idempotency
 * key already exists (the work is already scheduled or done) — INSERT OR
 * IGNORE keeps that race-free.
 */
export async function createJob(db: D1Database, input: CreateJobInput): Promise<JobRow | null> {
  const now = nowIso();
  const row: JobRow = {
    id: createId("job"),
    type: input.type,
    idempotency_key: input.idempotencyKey,
    owner_type: input.ownerType ?? null,
    owner_id: input.ownerId ?? null,
    status: "pending",
    attempts: 0,
    max_attempts: input.maxAttempts ?? 5,
    next_run_at: input.nextRunAt,
    lease_id: null,
    lease_expires_at: null,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    last_error: null,
    created_at: now,
    updated_at: now
  };
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO jobs (
        id, type, idempotency_key, owner_type, owner_id, status, attempts, max_attempts,
        next_run_at, lease_id, lease_expires_at, payload, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.type,
      row.idempotency_key,
      row.owner_type,
      row.owner_id,
      row.status,
      row.attempts,
      row.max_attempts,
      row.next_run_at,
      row.lease_id,
      row.lease_expires_at,
      row.payload,
      row.last_error,
      row.created_at,
      row.updated_at
    )
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  if (changes === 0) return null;
  return row;
}

export async function getJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

export async function getJobByIdempotencyKey(db: D1Database, key: string): Promise<JobRow | null> {
  return db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").bind(key).first<JobRow>();
}

export type LeaseResult = { job: JobRow; leaseId: string };

/**
 * Atomically leases a job for execution. A single conditional UPDATE is the
 * lock: only one consumer can transition the row, so duplicate queue
 * deliveries and the cron sweeper can all race safely. Returns null when the
 * job is not leasable (already leased with a live lease, completed, terminal,
 * or not yet due).
 */
export async function leaseJob(db: D1Database, id: string, leaseSeconds: number): Promise<LeaseResult | null> {
  const now = nowIso();
  const leaseId = createId("lease");
  const leaseExpires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const result = await db
    .prepare(
      `UPDATE jobs SET
        status = 'leased',
        lease_id = ?,
        lease_expires_at = ?,
        attempts = attempts + 1,
        updated_at = ?
      WHERE id = ?
        AND next_run_at <= ?
        AND (
          status = 'pending'
          OR status = 'failed_retryable'
          OR (status = 'leased' AND lease_expires_at < ?)
        )`
    )
    .bind(leaseId, leaseExpires, now, id, now, now)
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  if (changes !== 1) return null;
  const job = await getJob(db, id);
  if (!job) return null;
  return { job, leaseId };
}

/** Marks a leased job done. The lease id guards against expired-lease races. */
export async function completeJob(db: D1Database, id: string, leaseId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE jobs SET status = 'completed', lease_id = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND lease_id = ?")
    .bind(nowIso(), id, leaseId)
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export type FailJobInput = {
  error: string;
  retryable: boolean;
  /** Next attempt time for retryable failures; computed by the caller (backoff). */
  nextRunAt?: string;
};

export type FailJobOutcome = "retry_scheduled" | "dead_letter" | "failed_terminal" | "lease_lost";

export async function failJob(db: D1Database, id: string, leaseId: string, input: FailJobInput): Promise<FailJobOutcome> {
  const job = await getJob(db, id);
  if (!job || job.lease_id !== leaseId) return "lease_lost";
  const error = input.error.slice(0, 2000);
  if (!input.retryable) {
    await db
      .prepare("UPDATE jobs SET status = 'failed_terminal', lease_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND lease_id = ?")
      .bind(error, nowIso(), id, leaseId)
      .run();
    return "failed_terminal";
  }
  if (job.attempts >= job.max_attempts) {
    await db
      .prepare("UPDATE jobs SET status = 'dead_letter', lease_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND lease_id = ?")
      .bind(error, nowIso(), id, leaseId)
      .run();
    return "dead_letter";
  }
  await db
    .prepare(
      "UPDATE jobs SET status = 'failed_retryable', lease_id = NULL, lease_expires_at = NULL, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND lease_id = ?"
    )
    .bind(error, input.nextRunAt ?? nowIso(), nowIso(), id, leaseId)
    .run();
  return "retry_scheduled";
}

/**
 * Jobs due for execution: pending/retryable past next_run_at, plus leased
 * jobs whose lease expired (consumer died mid-run). The cron sweeper
 * enqueues these; actual execution still goes through leaseJob.
 */
export async function listDueJobs(db: D1Database, limit = 100): Promise<JobRow[]> {
  const now = nowIso();
  const result = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE (status IN ('pending', 'failed_retryable') AND next_run_at <= ?)
          OR (status = 'leased' AND lease_expires_at < ?)
       ORDER BY next_run_at ASC
       LIMIT ?`
    )
    .bind(now, now, Math.min(limit, 200))
    .all<JobRow>();
  return result.results ?? [];
}

export async function listJobs(
  db: D1Database,
  options?: { status?: JobStatus; type?: JobType; ownerId?: string; limit?: number }
): Promise<JobRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (options?.status) {
    clauses.push("status = ?");
    binds.push(options.status);
  }
  if (options?.type) {
    clauses.push("type = ?");
    binds.push(options.type);
  }
  if (options?.ownerId) {
    clauses.push("owner_id = ?");
    binds.push(options.ownerId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(options?.limit ?? 100, 500);
  const result = await db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY updated_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<JobRow>();
  return result.results ?? [];
}

/**
 * Cancels not-yet-finished jobs for an owner (e.g. when an occurrence is
 * canceled or rescheduled). Leased jobs are canceled too — their consumer
 * will find the lease gone via completeJob/failJob and drop the work.
 */
export async function cancelJobsForOwner(db: D1Database, ownerType: string, ownerId: string, types?: JobType[]): Promise<number> {
  const typeFilter = types && types.length > 0 ? ` AND type IN (${types.map(() => "?").join(", ")})` : "";
  const result = await db
    .prepare(
      `UPDATE jobs SET status = 'canceled', lease_id = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE owner_type = ? AND owner_id = ? AND status IN ('pending', 'failed_retryable', 'leased')${typeFilter}`
    )
    .bind(nowIso(), ownerType, ownerId, ...(types ?? []))
    .run();
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

/** Resets a dead-letter/terminal job for an admin-triggered retry. */
export async function requeueJob(db: D1Database, id: string): Promise<JobRow | null> {
  await db
    .prepare(
      `UPDATE jobs SET status = 'pending', attempts = 0, lease_id = NULL, lease_expires_at = NULL, next_run_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('dead_letter', 'failed_terminal', 'failed_retryable', 'canceled')`
    )
    .bind(nowIso(), nowIso(), id)
    .run();
  return getJob(db, id);
}

export async function deleteCompletedJobsBefore(db: D1Database, cutoffIso: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM jobs WHERE status = 'completed' AND updated_at < ?")
    .bind(cutoffIso)
    .run();
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

export function computeBackoffIso(attempts: number, baseSeconds = 60, maxSeconds = 3600): string {
  const delay = Math.min(baseSeconds * 2 ** Math.max(0, attempts - 1), maxSeconds);
  return new Date(Date.now() + delay * 1000).toISOString();
}
