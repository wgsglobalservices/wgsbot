import { createId, isTerminalBotSessionState, nowIso, type BotSessionState } from "@minutesbot/shared";
import type { BotEventRow, BotSessionRow } from "./schema";

/**
 * Creates a bot session for an occurrence. Returns null when an active
 * session already exists — the partial unique index on
 * bot_sessions(occurrence_id) WHERE is_active = 1 makes this race-free, so
 * two queue consumers can never start two bots for the same occurrence.
 */
export async function createBotSession(db: D1Database, occurrenceId: string, joinAttempt: number): Promise<BotSessionRow | null> {
  const now = nowIso();
  const row: BotSessionRow = {
    id: createId("bot"),
    occurrence_id: occurrenceId,
    runtime_bot_id: null,
    state: "created",
    is_active: 1,
    join_attempt: joinAttempt,
    last_heartbeat_at: now,
    failure_stage: null,
    failure_reason: null,
    recording_r2_key: null,
    started_at: null,
    stopped_at: null,
    created_at: now,
    updated_at: now
  };
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO bot_sessions (
        id, occurrence_id, runtime_bot_id, state, is_active, join_attempt, last_heartbeat_at,
        failure_stage, failure_reason, recording_r2_key, started_at, stopped_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.occurrence_id,
      row.runtime_bot_id,
      row.state,
      row.is_active,
      row.join_attempt,
      row.last_heartbeat_at,
      row.failure_stage,
      row.failure_reason,
      row.recording_r2_key,
      row.started_at,
      row.stopped_at,
      row.created_at,
      row.updated_at
    )
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  if (changes === 0) return null;
  return row;
}

export async function getBotSession(db: D1Database, id: string): Promise<BotSessionRow | null> {
  return db.prepare("SELECT * FROM bot_sessions WHERE id = ?").bind(id).first<BotSessionRow>();
}

export async function getActiveBotSession(db: D1Database, occurrenceId: string): Promise<BotSessionRow | null> {
  return db
    .prepare("SELECT * FROM bot_sessions WHERE occurrence_id = ? AND is_active = 1")
    .bind(occurrenceId)
    .first<BotSessionRow>();
}

export async function findBotSessionByRuntimeId(db: D1Database, runtimeBotId: string): Promise<BotSessionRow | null> {
  return db
    .prepare("SELECT * FROM bot_sessions WHERE runtime_bot_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(runtimeBotId)
    .first<BotSessionRow>();
}

export async function listBotSessionsForOccurrence(db: D1Database, occurrenceId: string): Promise<BotSessionRow[]> {
  const result = await db
    .prepare("SELECT * FROM bot_sessions WHERE occurrence_id = ? ORDER BY created_at DESC")
    .bind(occurrenceId)
    .all<BotSessionRow>();
  return result.results ?? [];
}

export async function setBotSessionRuntimeId(db: D1Database, id: string, runtimeBotId: string): Promise<void> {
  await db
    .prepare("UPDATE bot_sessions SET runtime_bot_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?")
    .bind(runtimeBotId, nowIso(), nowIso(), id)
    .run();
}

export type UpdateBotSessionStateInput = {
  state: BotSessionState;
  failureStage?: string | null;
  failureReason?: string | null;
  recordingR2Key?: string | null;
};

export async function updateBotSessionState(db: D1Database, id: string, input: UpdateBotSessionStateInput): Promise<void> {
  const terminal = isTerminalBotSessionState(input.state);
  await db
    .prepare(
      `UPDATE bot_sessions SET
        state = ?,
        is_active = ?,
        last_heartbeat_at = ?,
        failure_stage = COALESCE(?, failure_stage),
        failure_reason = COALESCE(?, failure_reason),
        recording_r2_key = COALESCE(?, recording_r2_key),
        stopped_at = CASE WHEN ? = 1 THEN COALESCE(stopped_at, ?) ELSE stopped_at END,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      input.state,
      terminal ? 0 : 1,
      nowIso(),
      input.failureStage ?? null,
      input.failureReason ?? null,
      input.recordingR2Key ?? null,
      terminal ? 1 : 0,
      nowIso(),
      nowIso(),
      id
    )
    .run();
}

export async function touchBotSessionHeartbeat(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE bot_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), id).run();
}

/**
 * Active sessions whose last heartbeat is older than the cutoff — candidates
 * for stale-session recovery (runtime crashed or webhook path broke).
 */
export async function listStaleBotSessions(db: D1Database, heartbeatCutoffIso: string): Promise<BotSessionRow[]> {
  const result = await db
    .prepare("SELECT * FROM bot_sessions WHERE is_active = 1 AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?) LIMIT 100")
    .bind(heartbeatCutoffIso)
    .all<BotSessionRow>();
  return result.results ?? [];
}

export type InsertBotEventInput = {
  botSessionId: string;
  eventType: string;
  state?: string | null;
  payloadHash?: string | null;
  payload?: string | null;
  payloadR2Key?: string | null;
  idempotencyKey?: string | null;
};

/**
 * Records a webhook event. Returns null when the idempotency key was already
 * seen (duplicate delivery) — INSERT OR IGNORE keeps the check race-free.
 */
export async function insertBotEvent(db: D1Database, input: InsertBotEventInput): Promise<BotEventRow | null> {
  const row: BotEventRow = {
    id: createId("bev"),
    bot_session_id: input.botSessionId,
    event_type: input.eventType,
    state: input.state ?? null,
    payload_hash: input.payloadHash ?? null,
    payload: input.payload ?? null,
    payload_r2_key: input.payloadR2Key ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    received_at: nowIso()
  };
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO bot_events (id, bot_session_id, event_type, state, payload_hash, payload, payload_r2_key, idempotency_key, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.bot_session_id,
      row.event_type,
      row.state,
      row.payload_hash,
      row.payload,
      row.payload_r2_key,
      row.idempotency_key,
      row.received_at
    )
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  if (input.idempotencyKey && changes === 0) return null;
  return row;
}

export async function listBotEvents(db: D1Database, botSessionId: string, limit = 200): Promise<BotEventRow[]> {
  const result = await db
    .prepare("SELECT * FROM bot_events WHERE bot_session_id = ? ORDER BY received_at DESC LIMIT ?")
    .bind(botSessionId, Math.min(limit, 500))
    .all<BotEventRow>();
  return result.results ?? [];
}
