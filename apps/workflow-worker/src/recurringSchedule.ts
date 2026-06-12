import {
  createArtifact,
  getSettings,
  listActiveMeetingSeries,
  listMeetingCalendarUidsForSeries,
  replaceMeetingAttendees,
  updateMeetingSeriesExpandedUntil,
  upsertMeeting,
  type MeetingSeriesRow
} from "@minutesbot/db";
import { expandInviteOccurrences, type NormalizedAttendee, type ParsedMeetingInvite, type ParsedRecurrence } from "@minutesbot/invite-parser";
import { shouldCreateBotNow } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";

const DEFAULT_EXTENSION_HORIZON_DAYS = 180;
const DEFAULT_EXTENSION_MAX_OCCURRENCES = 60;

type StoredAttendee = {
  email: string;
  name?: string | null;
  role?: string | null;
  domain?: string | null;
  summary_eligible: number;
  exclusion_reason?: string | null;
};

export async function extendRecurringMeetingSchedules(
  env: WorkflowEnv,
  options: { now?: Date; horizonDays?: number; maxOccurrences?: number } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const settings = await getSettings(env.DB);
  let created = 0;

  for (const series of await listActiveMeetingSeries(env.DB)) {
    const recurrence = parseRecurrence(series.recurrence_json);
    const attendees = parseAttendees(series.attendees_json);
    if (!recurrence || attendees.length === 0) continue;

    const invite = seriesToInvite(series, recurrence, attendees);
    const occurrences = expandInviteOccurrences(invite, {
      now,
      horizonDays: options.horizonDays ?? DEFAULT_EXTENSION_HORIZON_DAYS,
      maxOccurrences: options.maxOccurrences ?? DEFAULT_EXTENSION_MAX_OCCURRENCES
    });
    const existing = new Set(await listMeetingCalendarUidsForSeries(env.DB, series.series_uid));
    let expandedUntil = series.expanded_until ?? null;

    for (const occurrence of occurrences) {
      if (occurrence.startTime > (expandedUntil ?? "")) expandedUntil = occurrence.startTime;
      if (existing.has(occurrence.calendarUid)) continue;

      const shouldQueueNow = shouldCreateBotNow(occurrence.startTime, settings.attendee.createBotMinutesBeforeStart, now);
      const meeting = await upsertMeeting(env.DB, {
        calendar_uid: occurrence.calendarUid,
        subject: series.subject,
        organizer_email: series.organizer_email,
        organizer_name: series.organizer_name,
        teams_join_url: series.teams_join_url,
        start_time: occurrence.startTime,
        end_time: occurrence.endTime,
        time_zone: occurrence.timeZone ?? series.time_zone,
        meeting_type: series.meeting_type ?? "general",
        source_recipient: series.source_recipient,
        series_uid: occurrence.seriesUid,
        occurrence_index: occurrence.occurrenceIndex,
        recurring: occurrence.recurring ? 1 : 0,
        status: shouldQueueNow ? "SCHEDULED" : "WAITING_TO_CREATE_BOT"
      });
      await replaceMeetingAttendees(env.DB, meeting.id, attendees);
      if (series.raw_invite_r2_key) {
        await createArtifact(env.DB, {
          meeting_id: meeting.id,
          type: "raw_invite",
          r2_key: series.raw_invite_r2_key,
          content_type: "message/rfc822",
          size_bytes: series.raw_invite_size_bytes ?? null,
          deleted_at: null
        });
      }
      if (shouldQueueNow) await env.INVITE_QUEUE.send({ type: "create_bot", meetingId: meeting.id });
      created += 1;
    }

    if (expandedUntil && expandedUntil !== series.expanded_until) await updateMeetingSeriesExpandedUntil(env.DB, series.series_uid, expandedUntil);
  }

  return created;
}

function seriesToInvite(series: MeetingSeriesRow, recurrence: ParsedRecurrence, attendees: StoredAttendee[]): ParsedMeetingInvite {
  return {
    kind: "request",
    calendarUid: series.series_uid,
    seriesUid: series.series_uid,
    subject: series.subject,
    organizer: {
      email: series.organizer_email,
      ...(series.organizer_name ? { name: series.organizer_name } : {})
    },
    attendees: attendees.map((attendee): NormalizedAttendee => ({
      email: attendee.email,
      ...(attendee.name ? { name: attendee.name } : {}),
      ...(attendee.role === "required" || attendee.role === "optional" || attendee.role === "resource" ? { role: attendee.role } : {})
    })),
    startTime: series.first_start_time,
    endTime: series.first_end_time,
    ...(series.time_zone ? { timeZone: series.time_zone } : {}),
    teamsJoinUrl: series.teams_join_url ?? null,
    rawRecipient: series.source_recipient ?? "",
    rawSender: series.organizer_email,
    recurrence
  };
}

function parseRecurrence(value: string): ParsedRecurrence | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const recurrence = parsed as Partial<ParsedRecurrence>;
    if (!["daily", "weekly", "monthly", "yearly"].includes(String(recurrence.frequency))) return null;
    if (!Number.isInteger(recurrence.interval) || Number(recurrence.interval) <= 0) return null;
    return recurrence as ParsedRecurrence;
  } catch {
    return null;
  }
}

function parseAttendees(value: string): StoredAttendee[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((attendee): attendee is StoredAttendee => Boolean(attendee) && typeof attendee === "object" && typeof (attendee as StoredAttendee).email === "string");
  } catch {
    return [];
  }
}
