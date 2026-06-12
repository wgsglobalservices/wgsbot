import { createId, nowIso, type MeetingStatus, type SummaryStatus, type TranscriptStatus } from "@minutesbot/shared";
import type { AttendeeRow, MeetingRow, TranscriptSegmentRow, WebhookEventRow } from "./schema";

export type MeetingListRow = MeetingRow & { eligible_recipient_count: number };

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
    meeting_type: input.meeting_type ?? existing?.meeting_type ?? "general",
    source_recipient: input.source_recipient ?? existing?.source_recipient ?? null,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  await db
    .prepare(
      `INSERT INTO meetings (
        id, calendar_uid, subject, organizer_email, organizer_name, teams_join_url, start_time, end_time, status,
        attendee_bot_id, attendee_bot_state, attendee_transcription_state, attendee_recording_state, attendee_last_event_at,
        transcript_status, summary_status, latest_error, meeting_type, source_recipient, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(calendar_uid) WHERE calendar_uid IS NOT NULL DO UPDATE SET
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
        meeting_type = excluded.meeting_type,
        source_recipient = excluded.source_recipient,
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
      row.meeting_type,
      row.source_recipient,
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

export async function listMeetingsWithEligibleRecipientCounts(db: D1Database, options: { futureHorizonIso?: string } = {}): Promise<MeetingListRow[]> {
  const whereClause = options.futureHorizonIso ? "WHERE meetings.start_time IS NULL OR meetings.start_time <= ?" : "";
  const statement = db
    .prepare(
      `SELECT meetings.*, COALESCE(eligible_recipients.eligible_recipient_count, 0) AS eligible_recipient_count
       FROM meetings
       LEFT JOIN (
         SELECT meeting_id, COUNT(*) AS eligible_recipient_count
         FROM attendees
         WHERE summary_eligible = 1
         GROUP BY meeting_id
       ) eligible_recipients ON eligible_recipients.meeting_id = meetings.id
       ${whereClause}
       ORDER BY meetings.start_time DESC, meetings.created_at DESC`
    );
  const result = options.futureHorizonIso
    ? await statement.bind(options.futureHorizonIso).all<MeetingListRow>()
    : await statement.all<MeetingListRow>();
  return result.results ?? [];
}

export async function getMeeting(db: D1Database, id: string): Promise<MeetingRow | null> {
  return db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<MeetingRow>();
}

export async function listMeetingsDueForBotCreation(db: D1Database, cutoffIso: string): Promise<Array<Pick<MeetingRow, "id">>> {
  const result = await db
    .prepare(
      `SELECT id FROM meetings
       WHERE attendee_bot_id IS NULL
         AND status IN ('SCHEDULED', 'WAITING_TO_CREATE_BOT')
         AND start_time IS NOT NULL
         AND start_time <= ?
       ORDER BY start_time ASC, created_at ASC`
    )
    .bind(cutoffIso)
    .all<Pick<MeetingRow, "id">>();
  return result.results ?? [];
}

export async function markStaleRecurringOccurrencesCancelled(
  db: D1Database,
  input: { seriesUid: string; keepCalendarUids: string[]; nowIso: string }
): Promise<void> {
  if (input.keepCalendarUids.length === 0) return;
  const placeholders = input.keepCalendarUids.map(() => "?").join(", ");
  await db
    .prepare(
      `UPDATE meetings
       SET status = ?, latest_error = ?, updated_at = ?
       WHERE calendar_uid LIKE ?
         AND calendar_uid NOT IN (${placeholders})
         AND attendee_bot_id IS NULL
         AND start_time > ?
         AND status IN ('SCHEDULED', 'WAITING_TO_CREATE_BOT')`
    )
    .bind("CANCELLED", null, input.nowIso, `${input.seriesUid}:%`, ...input.keepCalendarUids, input.nowIso)
    .run();
}

export async function claimMeetingBotCreation(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE meetings
       SET status = ?, latest_error = ?, updated_at = ?
       WHERE id = ?
         AND attendee_bot_id IS NULL
         AND status IN ('SCHEDULED', 'WAITING_TO_CREATE_BOT', 'FAILED')`
    )
    .bind("BOT_CREATE_QUEUED", null, nowIso(), id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function deleteMeetingRecord(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM attendees WHERE meeting_id = ?").bind(id).run();
  await db.prepare("DELETE FROM transcript_segments WHERE meeting_id = ?").bind(id).run();
  await db.prepare("DELETE FROM attendee_webhook_events WHERE meeting_id = ?").bind(id).run();
  await db.prepare("DELETE FROM summaries WHERE meeting_id = ?").bind(id).run();
  await db.prepare("DELETE FROM email_deliveries WHERE meeting_id = ?").bind(id).run();
  await db.prepare("DELETE FROM artifacts WHERE meeting_id = ?").bind(id).run();
  await db.prepare("DELETE FROM meetings WHERE id = ?").bind(id).run();
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
  input: { botId?: string; state?: string; transcriptionState?: string; recordingState?: string; status?: MeetingStatus }
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
           updated_at = ?
       WHERE id = ?`
    )
    .bind(input.botId ?? null, input.state ?? null, input.transcriptionState ?? null, input.recordingState ?? null, nowIso(), input.status ?? null, nowIso(), id)
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
  await db.prepare("DELETE FROM attendees WHERE meeting_id = ?").bind(meetingId).run();
  for (const attendee of attendees) {
    await db
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
      .run();
  }
}

export async function listMeetingAttendees(db: D1Database, meetingId: string): Promise<AttendeeRow[]> {
  const result = await db.prepare("SELECT * FROM attendees WHERE meeting_id = ? ORDER BY email").bind(meetingId).all<AttendeeRow>();
  return result.results ?? [];
}

export async function insertTranscriptSegment(
  db: D1Database,
  input: Omit<TranscriptSegmentRow, "id" | "created_at"> & { id?: string }
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO transcript_segments (id, meeting_id, attendee_bot_id, speaker_name, speaker_uuid, speaker_user_uuid, timestamp_ms, duration_ms, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      input.id ?? createId("seg"),
      input.meeting_id,
      input.attendee_bot_id ?? null,
      input.speaker_name ?? null,
      input.speaker_uuid ?? null,
      input.speaker_user_uuid ?? null,
      input.timestamp_ms ?? null,
      input.duration_ms ?? null,
      input.text,
      input.source,
      nowIso()
    )
    .run();
}

export async function listTranscriptSegments(db: D1Database, meetingId: string): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare("SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY timestamp_ms ASC").bind(meetingId).all<Record<string, unknown>>();
  return result.results ?? [];
}

export async function insertWebhookEvent(db: D1Database, input: Omit<WebhookEventRow, "id" | "created_at">): Promise<WebhookEventRow | null> {
  const existing = input.idempotency_key
    ? await db.prepare("SELECT * FROM attendee_webhook_events WHERE idempotency_key = ?").bind(input.idempotency_key).first<WebhookEventRow>()
    : null;
  if (existing) return null;
  const row: WebhookEventRow = { ...input, id: createId("wh"), created_at: nowIso() };
  await db
    .prepare(
      "INSERT INTO attendee_webhook_events (id, idempotency_key, meeting_id, attendee_bot_id, trigger, event_type, event_sub_type, payload, processed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(row.id, row.idempotency_key ?? null, row.meeting_id ?? null, row.attendee_bot_id ?? null, row.trigger, row.event_type ?? null, row.event_sub_type ?? null, row.payload, row.processed_at ?? null, row.created_at)
    .run();
  return row;
}

export async function listWebhookEvents(db: D1Database, meetingId: string): Promise<WebhookEventRow[]> {
  const result = await db.prepare("SELECT * FROM attendee_webhook_events WHERE meeting_id = ? ORDER BY created_at DESC").bind(meetingId).all<WebhookEventRow>();
  return result.results ?? [];
}
