import { createId, nowIso } from "@minutesbot/shared";
import type { SummaryRow } from "./schema";

export async function createSummary(db: D1Database, input: Omit<SummaryRow, "id" | "created_at">): Promise<SummaryRow> {
  const row: SummaryRow = { ...input, id: createId("sum"), created_at: nowIso() };
  await db
    .prepare("INSERT INTO summaries (id, meeting_id, r2_key, summary_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.meeting_id, row.r2_key ?? null, row.summary_json, row.model ?? null, row.created_at)
    .run();
  return row;
}

export async function getLatestSummary(db: D1Database, meetingId: string): Promise<SummaryRow | null> {
  return db.prepare("SELECT * FROM summaries WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1").bind(meetingId).first<SummaryRow>();
}

export async function listSummaryR2Keys(db: D1Database, meetingId: string): Promise<string[]> {
  const result = await db.prepare("SELECT r2_key FROM summaries WHERE meeting_id = ? AND r2_key IS NOT NULL").bind(meetingId).all<{ r2_key: string }>();
  return (result.results ?? []).map((row) => row.r2_key).filter(Boolean);
}
