import { createId, nowIso } from "@minutesbot/shared";
import type { AttendeeRow } from "./schema";

export type AttendeeInput = {
  email: string;
  name?: string | null;
  role?: string | null;
  domain?: string | null;
  isExternal: boolean;
  recipientEligible: boolean;
  exclusionReason?: string | null;
};

/**
 * Replaces the attendee list at series level (occurrenceId null) or for a
 * single overridden occurrence. Batched so a mid-write failure cannot leave
 * the list half-replaced.
 */
export async function replaceAttendees(
  db: D1Database,
  eventId: string,
  occurrenceId: string | null,
  attendees: AttendeeInput[]
): Promise<void> {
  const deleteStatement = occurrenceId
    ? db.prepare("DELETE FROM attendees WHERE event_id = ? AND occurrence_id = ?").bind(eventId, occurrenceId)
    : db.prepare("DELETE FROM attendees WHERE event_id = ? AND occurrence_id IS NULL").bind(eventId);
  await db.batch([
    deleteStatement,
    ...attendees.map((attendee) =>
      db
        .prepare(
          `INSERT INTO attendees (id, event_id, occurrence_id, email, name, role, domain, is_external, recipient_eligible, exclusion_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          createId("att"),
          eventId,
          occurrenceId,
          attendee.email,
          attendee.name ?? null,
          attendee.role ?? null,
          attendee.domain ?? null,
          attendee.isExternal ? 1 : 0,
          attendee.recipientEligible ? 1 : 0,
          attendee.exclusionReason ?? null,
          nowIso()
        )
    )
  ]);
}

export async function listEventAttendees(db: D1Database, eventId: string): Promise<AttendeeRow[]> {
  const result = await db
    .prepare("SELECT * FROM attendees WHERE event_id = ? AND occurrence_id IS NULL ORDER BY email")
    .bind(eventId)
    .all<AttendeeRow>();
  return result.results ?? [];
}

/**
 * Attendees effective for an occurrence: the occurrence's own list when an
 * override provided one, otherwise the series-level list.
 */
export async function listEffectiveAttendees(db: D1Database, eventId: string, occurrenceId: string): Promise<AttendeeRow[]> {
  const overrides = await db
    .prepare("SELECT * FROM attendees WHERE event_id = ? AND occurrence_id = ? ORDER BY email")
    .bind(eventId, occurrenceId)
    .all<AttendeeRow>();
  if ((overrides.results ?? []).length > 0) return overrides.results ?? [];
  return listEventAttendees(db, eventId);
}
