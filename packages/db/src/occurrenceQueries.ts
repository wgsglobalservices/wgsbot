import { createId, isTerminalOccurrenceStatus, nowIso, type OccurrenceStatus } from "@minutesbot/shared";
import type { OccurrenceRow } from "./schema";

export type UpsertOccurrenceInput = {
  eventId: string;
  occurrenceKey: string;
  recurrenceId?: string | null;
  sequence?: number;
  isOverride?: boolean;
  subject?: string | null;
  teamsJoinUrl?: string | null;
  startTime: string;
  endTime: string;
  scheduledJoinTime?: string | null;
};

export type UpsertOccurrenceResult = {
  occurrence: OccurrenceRow;
  created: boolean;
  /** True when start/end/url changed on an existing row. */
  rescheduled: boolean;
  /** False when the incoming sequence is older or the occurrence already ran. */
  applied: boolean;
};

/**
 * Creates or updates a single occurrence. Occurrences whose pipeline already
 * progressed past joining are never rescheduled by calendar updates — the
 * recording is in flight or done. Stale sequences are ignored.
 */
export async function upsertOccurrence(db: D1Database, input: UpsertOccurrenceInput): Promise<UpsertOccurrenceResult> {
  const now = nowIso();
  const existing = await getOccurrenceByKey(db, input.eventId, input.occurrenceKey);
  if (!existing) {
    const row: OccurrenceRow = {
      id: createId("occ"),
      event_id: input.eventId,
      occurrence_key: input.occurrenceKey,
      recurrence_id: input.recurrenceId ?? null,
      sequence: input.sequence ?? 0,
      is_override: input.isOverride ? 1 : 0,
      subject: input.subject ?? null,
      teams_join_url: input.teamsJoinUrl ?? null,
      start_time: input.startTime,
      end_time: input.endTime,
      status: "scheduled",
      scheduled_join_time: input.scheduledJoinTime ?? null,
      latest_bot_session_id: null,
      join_attempts: 0,
      last_error: null,
      canceled_at: null,
      created_at: now,
      updated_at: now
    };
    // INSERT OR IGNORE + re-read keeps concurrent expansion race-free on the
    // UNIQUE(event_id, occurrence_key) index.
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO meeting_occurrences (
          id, event_id, occurrence_key, recurrence_id, sequence, is_override, subject, teams_join_url,
          start_time, end_time, status, scheduled_join_time, latest_bot_session_id, join_attempts,
          last_error, canceled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        row.id,
        row.event_id,
        row.occurrence_key,
        row.recurrence_id,
        row.sequence,
        row.is_override,
        row.subject,
        row.teams_join_url,
        row.start_time,
        row.end_time,
        row.status,
        row.scheduled_join_time,
        row.latest_bot_session_id,
        row.join_attempts,
        row.last_error,
        row.canceled_at,
        row.created_at,
        row.updated_at
      )
      .run();
    const changes = (result as { meta?: { changes?: number } }).meta?.changes;
    if (changes === 0) {
      const winner = await getOccurrenceByKey(db, input.eventId, input.occurrenceKey);
      if (winner) return { occurrence: winner, created: false, rescheduled: false, applied: false };
    }
    return { occurrence: row, created: true, rescheduled: false, applied: true };
  }

  if (input.sequence !== undefined && input.sequence < existing.sequence) {
    return { occurrence: existing, created: false, rescheduled: false, applied: false };
  }
  if (isTerminalOccurrenceStatus(existing.status) && existing.status !== "canceled" && existing.status !== "skipped") {
    // Completed/failed occurrences keep their history; updates can't rewind them.
    return { occurrence: existing, created: false, rescheduled: false, applied: false };
  }
  const inProgress = ["in_meeting", "post_meeting", "transcribing", "summarizing", "sending_recap"].includes(existing.status);
  if (inProgress) {
    return { occurrence: existing, created: false, rescheduled: false, applied: false };
  }
  const rescheduled =
    existing.start_time !== input.startTime ||
    existing.end_time !== input.endTime ||
    (input.teamsJoinUrl != null && existing.teams_join_url !== input.teamsJoinUrl);
  // A canceled occurrence that gets re-invited (sequence moved on) returns to
  // scheduled; otherwise keep the current pipeline status.
  const status: OccurrenceStatus =
    existing.status === "canceled" || existing.status === "skipped" ? "scheduled" : existing.status;
  await db
    .prepare(
      `UPDATE meeting_occurrences SET
        recurrence_id = COALESCE(?, recurrence_id),
        sequence = ?,
        is_override = ?,
        subject = COALESCE(?, subject),
        teams_join_url = COALESCE(?, teams_join_url),
        start_time = ?,
        end_time = ?,
        status = ?,
        scheduled_join_time = COALESCE(?, scheduled_join_time),
        canceled_at = NULL,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      input.recurrenceId ?? null,
      input.sequence ?? existing.sequence,
      input.isOverride ? 1 : existing.is_override,
      input.subject ?? null,
      input.teamsJoinUrl ?? null,
      input.startTime,
      input.endTime,
      status,
      input.scheduledJoinTime ?? null,
      now,
      existing.id
    )
    .run();
  const saved = await getOccurrence(db, existing.id);
  return { occurrence: saved ?? existing, created: false, rescheduled, applied: true };
}

export async function getOccurrence(db: D1Database, id: string): Promise<OccurrenceRow | null> {
  return db.prepare("SELECT * FROM meeting_occurrences WHERE id = ?").bind(id).first<OccurrenceRow>();
}

export async function getOccurrenceByKey(db: D1Database, eventId: string, occurrenceKey: string): Promise<OccurrenceRow | null> {
  return db
    .prepare("SELECT * FROM meeting_occurrences WHERE event_id = ? AND occurrence_key = ?")
    .bind(eventId, occurrenceKey)
    .first<OccurrenceRow>();
}

export async function listOccurrencesForEvent(db: D1Database, eventId: string): Promise<OccurrenceRow[]> {
  const result = await db
    .prepare("SELECT * FROM meeting_occurrences WHERE event_id = ? ORDER BY start_time ASC")
    .bind(eventId)
    .all<OccurrenceRow>();
  return result.results ?? [];
}

export async function listOccurrences(
  db: D1Database,
  options?: { status?: OccurrenceStatus; from?: string; to?: string; limit?: number }
): Promise<OccurrenceRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (options?.status) {
    clauses.push("status = ?");
    binds.push(options.status);
  }
  if (options?.from) {
    clauses.push("start_time >= ?");
    binds.push(options.from);
  }
  if (options?.to) {
    clauses.push("start_time < ?");
    binds.push(options.to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(options?.limit ?? 200, 500);
  const result = await db
    .prepare(`SELECT * FROM meeting_occurrences ${where} ORDER BY start_time ASC LIMIT ?`)
    .bind(...binds, limit)
    .all<OccurrenceRow>();
  return result.results ?? [];
}

export async function updateOccurrenceStatus(
  db: D1Database,
  id: string,
  status: OccurrenceStatus,
  options?: { lastError?: string | null; latestBotSessionId?: string | null }
): Promise<void> {
  await db
    .prepare(
      `UPDATE meeting_occurrences
       SET status = ?,
           last_error = COALESCE(?, last_error),
           latest_bot_session_id = COALESCE(?, latest_bot_session_id),
           canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE canceled_at END,
           updated_at = ?
       WHERE id = ?`
    )
    .bind(status, options?.lastError ?? null, options?.latestBotSessionId ?? null, status, nowIso(), nowIso(), id)
    .run();
}

export async function incrementOccurrenceJoinAttempts(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE meeting_occurrences SET join_attempts = join_attempts + 1, updated_at = ? WHERE id = ?")
    .bind(nowIso(), id)
    .run();
}

/**
 * Cancels occurrences of an event. With keys, only the listed occurrence keys
 * are canceled (single-occurrence cancel); otherwise every non-terminal
 * occurrence in the series is canceled (series cancel). Returns the canceled
 * rows so the caller can cancel their jobs and bots.
 */
export async function cancelOccurrences(db: D1Database, eventId: string, occurrenceKeys?: string[]): Promise<OccurrenceRow[]> {
  const candidates = await listOccurrencesForEvent(db, eventId);
  const keySet = occurrenceKeys ? new Set(occurrenceKeys) : null;
  const toCancel = candidates.filter(
    (row) => !isTerminalOccurrenceStatus(row.status) && (!keySet || keySet.has(row.occurrence_key))
  );
  if (toCancel.length === 0) return [];
  const now = nowIso();
  await db.batch(
    toCancel.map((row) =>
      db
        .prepare("UPDATE meeting_occurrences SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, row.id)
    )
  );
  return toCancel.map((row) => ({ ...row, status: "canceled" as const, canceled_at: now, updated_at: now }));
}

/**
 * Removes future, untouched occurrences that are no longer produced by the
 * series rules (e.g. the RRULE changed). Occurrences that already ran or
 * have an override are preserved.
 */
export async function pruneObsoleteOccurrences(db: D1Database, eventId: string, validKeys: Set<string>, afterIso: string): Promise<OccurrenceRow[]> {
  const candidates = await listOccurrencesForEvent(db, eventId);
  const obsolete = candidates.filter(
    (row) =>
      !validKeys.has(row.occurrence_key) &&
      row.is_override === 0 &&
      row.start_time >= afterIso &&
      (row.status === "scheduled" || row.status === "join_queued")
  );
  if (obsolete.length === 0) return [];
  const now = nowIso();
  await db.batch(
    obsolete.map((row) =>
      db
        .prepare("UPDATE meeting_occurrences SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, row.id)
    )
  );
  return obsolete;
}
