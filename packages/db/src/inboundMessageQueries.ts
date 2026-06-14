import { createId, nowIso, type InboundMessageStatus } from "@minutesbot/shared";
import type { InboundMessageRow } from "./schema";

export type CreateInboundMessageInput = {
  messageId?: string | null;
  contentHash: string;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  rawR2Key: string;
};

/**
 * Records an inbound email. Returns null when the same content hash was
 * already recorded (duplicate delivery / forwarded copy) so the caller can
 * skip reprocessing without racing.
 */
export async function createInboundMessage(db: D1Database, input: CreateInboundMessageInput): Promise<InboundMessageRow | null> {
  const row: InboundMessageRow = {
    id: createId("msg"),
    message_id: input.messageId ?? null,
    content_hash: input.contentHash,
    from_email: input.fromEmail ?? null,
    to_email: input.toEmail ?? null,
    subject: input.subject ?? null,
    raw_r2_key: input.rawR2Key,
    parse_status: "received",
    rejection_reason: null,
    ics_uid: null,
    ics_method: null,
    ics_sequence: null,
    recurrence_id: null,
    event_id: null,
    created_at: nowIso(),
    processed_at: null
  };
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO inbound_messages (
        id, message_id, content_hash, from_email, to_email, subject, raw_r2_key,
        parse_status, rejection_reason, ics_uid, ics_method, ics_sequence, recurrence_id, event_id, created_at, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.message_id,
      row.content_hash,
      row.from_email,
      row.to_email,
      row.subject,
      row.raw_r2_key,
      row.parse_status,
      row.rejection_reason,
      row.ics_uid,
      row.ics_method,
      row.ics_sequence,
      row.recurrence_id,
      row.event_id,
      row.created_at,
      row.processed_at
    )
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  if (changes === 0) return null;
  return row;
}

export type ResolveInboundMessageInput = {
  parseStatus: InboundMessageStatus;
  rejectionReason?: string | null;
  icsUid?: string | null;
  icsMethod?: string | null;
  icsSequence?: number | null;
  recurrenceId?: string | null;
  eventId?: string | null;
};

export async function resolveInboundMessage(db: D1Database, id: string, input: ResolveInboundMessageInput): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_messages
       SET parse_status = ?, rejection_reason = ?, ics_uid = ?, ics_method = ?, ics_sequence = ?, recurrence_id = ?, event_id = ?, processed_at = ?
       WHERE id = ?`
    )
    .bind(
      input.parseStatus,
      input.rejectionReason ?? null,
      input.icsUid ?? null,
      input.icsMethod ?? null,
      input.icsSequence ?? null,
      input.recurrenceId ?? null,
      input.eventId ?? null,
      nowIso(),
      id
    )
    .run();
}

export async function getInboundMessage(db: D1Database, id: string): Promise<InboundMessageRow | null> {
  return db.prepare("SELECT * FROM inbound_messages WHERE id = ?").bind(id).first<InboundMessageRow>();
}

export async function listInboundMessages(db: D1Database, options?: { limit?: number; status?: InboundMessageStatus }): Promise<InboundMessageRow[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  if (options?.status) {
    const result = await db
      .prepare("SELECT * FROM inbound_messages WHERE parse_status = ? ORDER BY created_at DESC LIMIT ?")
      .bind(options.status, limit)
      .all<InboundMessageRow>();
    return result.results ?? [];
  }
  const result = await db.prepare("SELECT * FROM inbound_messages ORDER BY created_at DESC LIMIT ?").bind(limit).all<InboundMessageRow>();
  return result.results ?? [];
}

export async function listInboundMessagesForEvent(db: D1Database, eventId: string): Promise<InboundMessageRow[]> {
  const result = await db
    .prepare("SELECT * FROM inbound_messages WHERE event_id = ? ORDER BY created_at DESC LIMIT 200")
    .bind(eventId)
    .all<InboundMessageRow>();
  return result.results ?? [];
}

export async function deleteInboundMessagesBefore(db: D1Database, cutoffIso: string): Promise<string[]> {
  const result = await db
    .prepare("SELECT id, raw_r2_key FROM inbound_messages WHERE created_at < ?")
    .bind(cutoffIso)
    .all<{ id: string; raw_r2_key: string }>();
  const rows = result.results ?? [];
  if (rows.length === 0) return [];
  await db.batch(rows.map((row) => db.prepare("DELETE FROM inbound_messages WHERE id = ?").bind(row.id)));
  return rows.map((row) => row.raw_r2_key);
}
