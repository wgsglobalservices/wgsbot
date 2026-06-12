import { createId, nowIso, type MeetingStatus, type SummaryStatus, type TranscriptStatus } from "@minutesbot/shared";
import type { AttendeeRow, MeetingRow, TranscriptSegmentRow, WebhookEventRow } from "./schema";

// Bot states after which a meeting can safely be re-scheduled by a new invite.
const settledBotStates = ["ended", "failed", "cancelled", "fatal_error"];

function hasLiveBot(meeting: MeetingRow): boolean {
  return Boolean(meeting.attendee_bot_id) && !settledBotStates.includes(meeting.attendee_bot_state ?? "");
}

export async function upsertMeeting(
  db: D1Database,
  input: Partial<MeetingRow> & Pick<MeetingRow, "calendar_uid" | "status">
): Promise<MeetingRow> {
  const now = nowIso();
  const existing = input.calendar_uid
    ? await db.prepare("SELECT * FROM meetings WHERE calendar_uid = ?").bind(input.calendar_uid).first<MeetingRow>()
    : null;
  // A calendar update for a meeting whose bot is live must not reset the
  // status back to SCHEDULED — that would hide the live recording and let a
  // second bot be created for the same meeting.
  const status = input.status === "SCHEDULED" && existing && hasLiveBot(existing) ? existing.status : input.status;
  const row: MeetingRow = {
    id: existing?.id ?? input.id ?? createId("mtg"),
    calendar_uid: input.calendar_uid,
    subject: input.subject ?? existing?.subject ?? null,
    organizer_email: input.organizer_email ?? existing?.organizer_email ?? null,
    organizer_name: input.organizer_name ?? existing?.organizer_name ?? null,
    teams_join_url: input.teams_join_url ?? existing?.teams_join_url ?? null,
    start_time: input.start_time ?? existing?.start_time ?? null,
    end_time: input.end_time ?? existing?.end_time ?? null,
    status,
    attendee_bot_id: input.attendee_bot_id ?? existing?.attendee_bot_id ?? null,
    attendee_bot_state: input.attendee_bot_state ?? existing?.attendee_bot_state ?? null,
    attendee_transcription_state: input.attendee_transcription_state ?? existing?.attendee_transcription_state ?? null,
    attendee_recording_state: input.attendee_recording_state ?? existing?.attendee_recording_state ?? null,
    attendee_last_event_at: input.attendee_last_event_at ?? existing?.attendee_last_event_at ?? null,
    transcript_status: input.transcript_status ?? existing?.transcript_status ?? "not_started",
    summary_status: input.summary_status ?? existing?.summary_status ?? "not_started",
    latest_error: input.latest_error ?? existing?.latest_error ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  // ON CONFLICT keeps the first writer's row id when two invites for the same
  // calendar UID race, so attendees/audit logs never reference an orphaned id
  // (requires the unique index from migration 0008).
  await db
    .prepare(
      `INSERT INTO meetings (
        id, calendar_uid, subject, organizer_email, organizer_name, teams_join_url, start_time, end_time, status,
        attendee_bot_id, attendee_bot_state, attendee_transcription_state, attendee_recording_state, attendee_last_event_at,
        transcript_status, summary_status, latest_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(calendar_uid) DO UPDATE SET
        subject = excluded.subject,
        organizer_email = excluded.organizer_email,
        organizer_name = excluded.organizer_name,
        teams_join_url = excluded.teams_join_url,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        status = excluded.status,
        attendee_bot_id = excluded.attendee_bot_id,
        attendee_bot_state = excluded.attendee_bot_state,
        attendee_transcription_state = excluded.attendee_transcription_state,
        attendee_recording_state = excluded.attendee_recording_state,
        attendee_last_event_at = excluded.attendee_last_event_at,
        transcript_status = excluded.transcript_status,
        summary_status = excluded.summary_status,
        latest_error = excluded.latest_error,
        updated_at = excluded.updated_at`
    )
    .bind(
      row.id,
      row.calendar_uid,
      row.subject,
      row.organizer_email,
      row.organizer_name,
      row.teams_join_url,
      row.start_time,
      row.end_time,
      row.status,
      row.attendee_bot_id,
      row.attendee_bot_state,
      row.attendee_transcription_state,
      row.attendee_recording_state,
      row.attendee_last_event_at,
      row.transcript_status,
      row.summary_status,
      row.latest_error,
      row.created_at,
      row.updated_at
    )
    .run();
  if (input.calendar_uid) {
    const saved = await db.prepare("SELECT * FROM meetings WHERE calendar_uid = ?").bind(input.calendar_uid).first<MeetingRow>();
    if (saved) return saved;
  }
  return row;
}

export async function listMeetings(db: D1Database): Promise<MeetingRow[]> {
  const result = await db.prepare("SELECT * FROM meetings ORDER BY start_time DESC, created_at DESC").all<MeetingRow>();
  return result.results ?? [];
}

export async function getMeeting(db: D1Database, id: string): Promise<MeetingRow | null> {
  return db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<MeetingRow>();
}

export async function deleteMeetingHistory(db: D1Database, id: string): Promise<void> {
  const dependentTables = [
    "attendees",
    "attendee_webhook_events",
    "transcript_segments",
    "artifacts",
    "email_deliveries",
    "summaries"
  ];
  // Batched so a partial failure cannot leave a half-purged meeting behind.
  await db.batch([
    ...dependentTables.map((table) => db.prepare(`DELETE FROM ${table} WHERE meeting_id = ?`).bind(id)),
    db.prepare("DELETE FROM meetings WHERE id = ?").bind(id)
  ]);
}

export async function findMeetingByBot(db: D1Database, botId: string): Promise<MeetingRow | null> {
  return db.prepare("SELECT * FROM meetings WHERE attendee_bot_id = ?").bind(botId).first<MeetingRow>();
}

export async function updateMeetingStatus(db: D1Database, id: string, status: MeetingStatus, latestError?: string): Promise<void> {
  await db.prepare("UPDATE meetings SET status = ?, latest_error = ?, updated_at = ? WHERE id = ?").bind(status, latestError ?? null, nowIso(), id).run();
}

export async function updateMeetingBotState(
  db: D1Database,
  id: string,
  input: { botId?: string; state?: string; transcriptionState?: string; recordingState?: string; status?: MeetingStatus; latestError?: string }
): Promise<void> {
  await db
    .prepare(
      `UPDATE meetings
       SET attendee_bot_id = COALESCE(?, attendee_bot_id),
           attendee_bot_state = COALESCE(?, attendee_bot_state),
           attendee_transcription_state = COALESCE(?, attendee_transcription_state),
           attendee_recording_state = COALESCE(?, attendee_recording_state),
           attendee_last_event_at = ?,
           status = COALESCE(?, status),
           latest_error = COALESCE(?, latest_error),
           updated_at = ?
       WHERE id = ?`
    )
    .bind(
      input.botId ?? null,
      input.state ?? null,
      input.transcriptionState ?? null,
      input.recordingState ?? null,
      nowIso(),
      input.status ?? null,
      input.latestError ?? null,
      nowIso(),
      id
    )
    .run();
}

export async function updateTranscriptStatus(db: D1Database, id: string, transcriptStatus: TranscriptStatus, meetingStatus?: MeetingStatus): Promise<void> {
  await db
    .prepare("UPDATE meetings SET transcript_status = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?")
    .bind(transcriptStatus, meetingStatus ?? null, nowIso(), id)
    .run();
}

export async function updateSummaryStatus(db: D1Database, id: string, summaryStatus: SummaryStatus, meetingStatus?: MeetingStatus): Promise<void> {
  await db
    .prepare("UPDATE meetings SET summary_status = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?")
    .bind(summaryStatus, meetingStatus ?? null, nowIso(), id)
    .run();
}

export async function replaceMeetingAttendees(db: D1Database, meetingId: string, attendees: Omit<AttendeeRow, "id" | "meeting_id" | "created_at">[]): Promise<void> {
  // Batched so a mid-write failure cannot leave the attendee list half-replaced.
  await db.batch([
    db.prepare("DELETE FROM attendees WHERE meeting_id = ?").bind(meetingId),
    ...attendees.map((attendee) =>
      db
        .prepare(
          "INSERT INTO attendees (id, meeting_id, email, name, role, domain, summary_eligible, exclusion_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          createId("att"),
          meetingId,
          attendee.email,
          attendee.name ?? null,
          attendee.role ?? null,
          attendee.domain ?? null,
          attendee.summary_eligible,
          attendee.exclusion_reason ?? null,
          nowIso()
        )
    )
  ]);
}

export async function listMeetingAttendees(db: D1Database, meetingId: string): Promise<AttendeeRow[]> {
  const result = await db.prepare("SELECT * FROM attendees WHERE meeting_id = ? ORDER BY email").bind(meetingId).all<AttendeeRow>();
  return result.results ?? [];
}

export async function listTranscriptSegments(db: D1Database, meetingId: string): Promise<TranscriptSegmentRow[]> {
  const result = await db.prepare("SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY timestamp_ms ASC").bind(meetingId).all<TranscriptSegmentRow>();
  return result.results ?? [];
}

export async function insertWebhookEvent(db: D1Database, input: Omit<WebhookEventRow, "id" | "created_at">): Promise<WebhookEventRow | null> {
  const row: WebhookEventRow = { ...input, id: createId("wh"), created_at: nowIso() };
  // INSERT OR IGNORE makes the idempotency check race-free: a concurrent
  // duplicate delivery reports zero changes instead of throwing on the
  // UNIQUE(idempotency_key) constraint.
  const result = await db
    .prepare(
      "INSERT OR IGNORE INTO attendee_webhook_events (id, idempotency_key, meeting_id, attendee_bot_id, trigger, event_type, event_sub_type, payload, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(row.id, row.idempotency_key ?? null, row.meeting_id ?? null, row.attendee_bot_id ?? null, row.trigger, row.event_type ?? null, row.event_sub_type ?? null, row.payload, row.processed_at ?? null, row.created_at)
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  if (input.idempotency_key && changes === 0) return null;
  return row;
}

export async function listWebhookEvents(db: D1Database, meetingId: string): Promise<WebhookEventRow[]> {
  const result = await db.prepare("SELECT * FROM attendee_webhook_events WHERE meeting_id = ? ORDER BY created_at DESC").bind(meetingId).all<WebhookEventRow>();
  return result.results ?? [];
}
