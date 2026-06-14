import { createId, nowIso, type RecapStatus } from "@minutesbot/shared";
import type { RecapRow } from "./schema";

/**
 * Gets or creates the recap row for an occurrence (one row per occurrence;
 * retries reuse it). INSERT OR IGNORE on the unique occurrence_id keeps
 * concurrent creation race-free.
 */
export async function ensureRecap(db: D1Database, occurrenceId: string): Promise<RecapRow> {
  const now = nowIso();
  const row: RecapRow = {
    id: createId("rcp"),
    occurrence_id: occurrenceId,
    status: "pending",
    provider: null,
    model: null,
    json_artifact_id: null,
    html_artifact_id: null,
    text_artifact_id: null,
    attempts: 0,
    last_error: null,
    created_at: now,
    updated_at: now
  };
  await db
    .prepare(
      `INSERT OR IGNORE INTO recaps (id, occurrence_id, status, provider, model, json_artifact_id, html_artifact_id, text_artifact_id, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.occurrence_id, row.status, row.provider, row.model, row.json_artifact_id, row.html_artifact_id, row.text_artifact_id, row.attempts, row.last_error, row.created_at, row.updated_at)
    .run();
  const saved = await getRecapForOccurrence(db, occurrenceId);
  return saved ?? row;
}

export async function getRecapForOccurrence(db: D1Database, occurrenceId: string): Promise<RecapRow | null> {
  return db.prepare("SELECT * FROM recaps WHERE occurrence_id = ?").bind(occurrenceId).first<RecapRow>();
}

export async function getRecap(db: D1Database, id: string): Promise<RecapRow | null> {
  return db.prepare("SELECT * FROM recaps WHERE id = ?").bind(id).first<RecapRow>();
}

export async function listRecentRecaps(db: D1Database, limit = 20): Promise<RecapRow[]> {
  const result = await db
    .prepare("SELECT * FROM recaps WHERE status = 'completed' ORDER BY updated_at DESC LIMIT ?")
    .bind(Math.min(limit, 100))
    .all<RecapRow>();
  return result.results ?? [];
}

export type UpdateRecapInput = {
  status: RecapStatus;
  provider?: string | null;
  model?: string | null;
  jsonArtifactId?: string | null;
  htmlArtifactId?: string | null;
  textArtifactId?: string | null;
  lastError?: string | null;
  incrementAttempts?: boolean;
};

export async function updateRecap(db: D1Database, id: string, input: UpdateRecapInput): Promise<void> {
  await db
    .prepare(
      `UPDATE recaps SET
        status = ?,
        provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        json_artifact_id = COALESCE(?, json_artifact_id),
        html_artifact_id = COALESCE(?, html_artifact_id),
        text_artifact_id = COALESCE(?, text_artifact_id),
        last_error = ?,
        attempts = attempts + ?,
        updated_at = ?
      WHERE id = ?`
    )
    .bind(
      input.status,
      input.provider ?? null,
      input.model ?? null,
      input.jsonArtifactId ?? null,
      input.htmlArtifactId ?? null,
      input.textArtifactId ?? null,
      input.lastError ?? null,
      input.incrementAttempts ? 1 : 0,
      nowIso(),
      id
    )
    .run();
}
