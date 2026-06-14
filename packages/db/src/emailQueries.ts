import { createId, nowIso, type DeliveryStatus } from "@minutesbot/shared";
import type { EmailDeliveryRow } from "./schema";

export type CreateDeliveryInput = {
  recapId: string;
  occurrenceId: string;
  recipientEmail: string;
  recipientDomain: string;
  status: DeliveryStatus;
  providerMessageId?: string | null;
  error?: string | null;
};

/**
 * Records one delivery row per recipient per recap. Re-sends update the
 * existing row (unique on recap_id + recipient_email) so retries cannot
 * double-count or resend to recipients that already succeeded.
 */
export async function upsertEmailDelivery(db: D1Database, input: CreateDeliveryInput): Promise<EmailDeliveryRow> {
  const now = nowIso();
  const sentAt = input.status === "sent" ? now : null;
  const row: EmailDeliveryRow = {
    id: createId("eml"),
    recap_id: input.recapId,
    occurrence_id: input.occurrenceId,
    recipient_email: input.recipientEmail,
    recipient_domain: input.recipientDomain,
    status: input.status,
    provider_message_id: input.providerMessageId ?? null,
    error: input.error ?? null,
    created_at: now,
    sent_at: sentAt
  };
  await db
    .prepare(
      `INSERT INTO email_deliveries (id, recap_id, occurrence_id, recipient_email, recipient_domain, status, provider_message_id, error, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(recap_id, recipient_email) DO UPDATE SET
         status = excluded.status,
         provider_message_id = excluded.provider_message_id,
         error = excluded.error,
         sent_at = COALESCE(excluded.sent_at, email_deliveries.sent_at)`
    )
    .bind(
      row.id,
      row.recap_id,
      row.occurrence_id,
      row.recipient_email,
      row.recipient_domain,
      row.status,
      row.provider_message_id,
      row.error,
      row.created_at,
      row.sent_at
    )
    .run();
  return row;
}

export async function listDeliveriesForRecap(db: D1Database, recapId: string): Promise<EmailDeliveryRow[]> {
  const result = await db
    .prepare("SELECT * FROM email_deliveries WHERE recap_id = ? ORDER BY recipient_email")
    .bind(recapId)
    .all<EmailDeliveryRow>();
  return result.results ?? [];
}

export async function listDeliveriesForOccurrence(db: D1Database, occurrenceId: string): Promise<EmailDeliveryRow[]> {
  const result = await db
    .prepare("SELECT * FROM email_deliveries WHERE occurrence_id = ? ORDER BY created_at DESC")
    .bind(occurrenceId)
    .all<EmailDeliveryRow>();
  return result.results ?? [];
}
