import { createId, nowIso, type CalendarEventStatus } from "@minutesbot/shared";
import type { CalendarEventRow } from "./schema";

export type UpsertCalendarEventInput = {
  icsUid: string;
  sequence: number;
  organizerEmail?: string | null;
  organizerName?: string | null;
  subject?: string | null;
  teamsJoinUrl?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  timeZone?: string | null;
  startWallClock?: string | null;
  rrule?: string | null;
  rdates?: string[] | null;
  exdates?: string[] | null;
  status?: CalendarEventStatus;
  lastInboundMessageId?: string | null;
};

export type UpsertCalendarEventResult = {
  event: CalendarEventRow;
  created: boolean;
  /** False when the stored sequence is newer than the incoming one. */
  applied: boolean;
};

/**
 * Creates or updates the series row for an ICS UID. Updates carrying a stale
 * SEQUENCE are ignored (replayed/out-of-order invites must not roll a series
 * back), but the existing row is still returned so callers can attach
 * audit records.
 */
export async function upsertCalendarEvent(db: D1Database, input: UpsertCalendarEventInput): Promise<UpsertCalendarEventResult> {
  const now = nowIso();
  const existing = await getCalendarEventByUid(db, input.icsUid);
  if (existing && input.sequence < existing.sequence) {
    return { event: existing, created: false, applied: false };
  }
  const row: CalendarEventRow = {
    id: existing?.id ?? createId("evt"),
    ics_uid: input.icsUid,
    sequence: input.sequence,
    organizer_email: input.organizerEmail ?? existing?.organizer_email ?? null,
    organizer_name: input.organizerName ?? existing?.organizer_name ?? null,
    subject: input.subject ?? existing?.subject ?? null,
    teams_join_url: input.teamsJoinUrl ?? existing?.teams_join_url ?? null,
    start_time: input.startTime ?? existing?.start_time ?? null,
    end_time: input.endTime ?? existing?.end_time ?? null,
    time_zone: input.timeZone ?? existing?.time_zone ?? null,
    start_wall_clock: input.startWallClock ?? existing?.start_wall_clock ?? null,
    rrule: input.rrule !== undefined ? input.rrule : (existing?.rrule ?? null),
    rdates: input.rdates !== undefined ? (input.rdates ? JSON.stringify(input.rdates) : null) : (existing?.rdates ?? null),
    exdates: input.exdates !== undefined ? (input.exdates ? JSON.stringify(input.exdates) : null) : (existing?.exdates ?? null),
    is_recurring: 0,
    status: input.status ?? existing?.status ?? "active",
    expanded_until: existing?.expanded_until ?? null,
    last_inbound_message_id: input.lastInboundMessageId ?? existing?.last_inbound_message_id ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  row.is_recurring = row.rrule || (row.rdates && row.rdates !== "[]") ? 1 : 0;
  // ON CONFLICT keeps the first writer's row id when two invites race on the
  // same UID (requires the unique index on ics_uid).
  await db
    .prepare(
      `INSERT INTO calendar_events (
        id, ics_uid, sequence, organizer_email, organizer_name, subject, teams_join_url,
        start_time, end_time, time_zone, start_wall_clock, rrule, rdates, exdates,
        is_recurring, status, expanded_until, last_inbound_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ics_uid) DO UPDATE SET
        sequence = excluded.sequence,
        organizer_email = excluded.organizer_email,
        organizer_name = excluded.organizer_name,
        subject = excluded.subject,
        teams_join_url = excluded.teams_join_url,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        time_zone = excluded.time_zone,
        start_wall_clock = excluded.start_wall_clock,
        rrule = excluded.rrule,
        rdates = excluded.rdates,
        exdates = excluded.exdates,
        is_recurring = excluded.is_recurring,
        status = excluded.status,
        last_inbound_message_id = excluded.last_inbound_message_id,
        updated_at = excluded.updated_at
      WHERE excluded.sequence >= calendar_events.sequence`
    )
    .bind(
      row.id,
      row.ics_uid,
      row.sequence,
      row.organizer_email,
      row.organizer_name,
      row.subject,
      row.teams_join_url,
      row.start_time,
      row.end_time,
      row.time_zone,
      row.start_wall_clock,
      row.rrule,
      row.rdates,
      row.exdates,
      row.is_recurring,
      row.status,
      row.expanded_until,
      row.last_inbound_message_id,
      row.created_at,
      row.updated_at
    )
    .run();
  const saved = await getCalendarEventByUid(db, input.icsUid);
  return { event: saved ?? row, created: !existing, applied: true };
}

export async function getCalendarEvent(db: D1Database, id: string): Promise<CalendarEventRow | null> {
  return db.prepare("SELECT * FROM calendar_events WHERE id = ?").bind(id).first<CalendarEventRow>();
}

export async function getCalendarEventByUid(db: D1Database, icsUid: string): Promise<CalendarEventRow | null> {
  return db.prepare("SELECT * FROM calendar_events WHERE ics_uid = ?").bind(icsUid).first<CalendarEventRow>();
}

export async function listCalendarEvents(db: D1Database, options?: { limit?: number; status?: CalendarEventStatus }): Promise<CalendarEventRow[]> {
  const limit = Math.min(options?.limit ?? 200, 500);
  if (options?.status) {
    const result = await db
      .prepare("SELECT * FROM calendar_events WHERE status = ? ORDER BY start_time DESC LIMIT ?")
      .bind(options.status, limit)
      .all<CalendarEventRow>();
    return result.results ?? [];
  }
  const result = await db.prepare("SELECT * FROM calendar_events ORDER BY start_time DESC LIMIT ?").bind(limit).all<CalendarEventRow>();
  return result.results ?? [];
}

/** Active recurring series whose expansion window needs to roll forward. */
export async function listEventsNeedingExpansion(db: D1Database, expandThroughIso: string): Promise<CalendarEventRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM calendar_events WHERE status = 'active' AND is_recurring = 1 AND (expanded_until IS NULL OR expanded_until < ?) LIMIT 200"
    )
    .bind(expandThroughIso)
    .all<CalendarEventRow>();
  return result.results ?? [];
}

export async function markEventExpanded(db: D1Database, id: string, expandedUntilIso: string): Promise<void> {
  await db
    .prepare("UPDATE calendar_events SET expanded_until = ?, updated_at = ? WHERE id = ?")
    .bind(expandedUntilIso, nowIso(), id)
    .run();
}

export async function cancelCalendarEvent(db: D1Database, id: string, sequence: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE calendar_events SET status = 'canceled', sequence = ?, updated_at = ? WHERE id = ? AND sequence <= ?")
    .bind(sequence, nowIso(), id, sequence)
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
}

export async function deleteCalendarEventCascade(db: D1Database, id: string): Promise<void> {
  // Batched so a partial failure cannot leave a half-purged event behind.
  await db.batch([
    db.prepare(
      "DELETE FROM email_deliveries WHERE occurrence_id IN (SELECT id FROM meeting_occurrences WHERE event_id = ?)"
    ).bind(id),
    db.prepare("DELETE FROM recaps WHERE occurrence_id IN (SELECT id FROM meeting_occurrences WHERE event_id = ?)").bind(id),
    db.prepare("DELETE FROM transcripts WHERE occurrence_id IN (SELECT id FROM meeting_occurrences WHERE event_id = ?)").bind(id),
    db.prepare(
      "DELETE FROM bot_events WHERE bot_session_id IN (SELECT bs.id FROM bot_sessions bs JOIN meeting_occurrences mo ON bs.occurrence_id = mo.id WHERE mo.event_id = ?)"
    ).bind(id),
    db.prepare("DELETE FROM bot_sessions WHERE occurrence_id IN (SELECT id FROM meeting_occurrences WHERE event_id = ?)").bind(id),
    db.prepare("DELETE FROM attendees WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM meeting_occurrences WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM calendar_events WHERE id = ?").bind(id)
  ]);
}
