import { createId, nowIso, type TranscriptStatus } from "@minutesbot/shared";
import type { TranscriptRow } from "./schema";

/**
 * Gets or creates the transcript row for an occurrence (one row per
 * occurrence; retries reuse it). INSERT OR IGNORE on the unique
 * occurrence_id keeps concurrent creation race-free.
 */
export async function ensureTranscript(db: D1Database, occurrenceId: string): Promise<TranscriptRow> {
  const now = nowIso();
  const row: TranscriptRow = {
    id: createId("trn"),
    occurrence_id: occurrenceId,
    status: "pending",
    provider: null,
    model: null,
    language: null,
    duration_seconds: null,
    json_artifact_id: null,
    text_artifact_id: null,
    attempts: 0,
    last_error: null,
    created_at: now,
    updated_at: now
  };
  await db
    .prepare(
      `INSERT OR IGNORE INTO transcripts (id, occurrence_id, status, provider, model, language, duration_seconds, json_artifact_id, text_artifact_id, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(row.id, row.occurrence_id, row.status, row.provider, row.model, row.language, row.duration_seconds, row.json_artifact_id, row.text_artifact_id, row.attempts, row.last_error, row.created_at, row.updated_at)
    .run();
  const saved = await getTranscriptForOccurrence(db, occurrenceId);
  return saved ?? row;
}

export async function getTranscriptForOccurrence(db: D1Database, occurrenceId: string): Promise<TranscriptRow | null> {
  return db.prepare("SELECT * FROM transcripts WHERE occurrence_id = ?").bind(occurrenceId).first<TranscriptRow>();
}

export type UpdateTranscriptInput = {
  status: TranscriptStatus;
  provider?: string | null;
  model?: string | null;
  language?: string | null;
  durationSeconds?: number | null;
  jsonArtifactId?: string | null;
  textArtifactId?: string | null;
  lastError?: string | null;
  incrementAttempts?: boolean;
};

export async function updateTranscript(db: D1Database, id: string, input: UpdateTranscriptInput): Promise<void> {
  await db
    .prepare(
      `UPDATE transcripts SET
        status = ?,
        provider = COALESCE(?, provider),
        model = COALESCE(?, model),
        language = COALESCE(?, language),
        duration_seconds = COALESCE(?, duration_seconds),
        json_artifact_id = COALESCE(?, json_artifact_id),
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
      input.language ?? null,
      input.durationSeconds ?? null,
      input.jsonArtifactId ?? null,
      input.textArtifactId ?? null,
      input.lastError ?? null,
      input.incrementAttempts ? 1 : 0,
      nowIso(),
      id
    )
    .run();
}
