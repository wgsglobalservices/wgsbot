import {
  findMeetingByBot,
  getMeeting,
  insertTranscriptSegment,
  insertWebhookEvent,
  listMeetingAttendees,
  updateMeetingBotState,
  updateMeetingStatus
} from "@minutesbot/db";
import type { AttendeeWebhookTrigger } from "@minutesbot/attendee-client";
import type { Env } from "../env";

export type AttendeeWebhookPayload = {
  idempotency_key?: string;
  bot_id: string;
  bot_metadata?: { minutesbot_meeting_id?: string; calendar_uid?: string };
  trigger: AttendeeWebhookTrigger;
  data: Record<string, unknown>;
};

export async function processAttendeeWebhook(env: Env, payload: AttendeeWebhookPayload): Promise<{ duplicate: boolean; meetingId?: string }> {
  const meeting =
    (payload.bot_metadata?.minutesbot_meeting_id ? await getMeeting(env.DB, payload.bot_metadata.minutesbot_meeting_id) : null) ??
    (await findMeetingByBot(env.DB, payload.bot_id));

  const event = await insertWebhookEvent(env.DB, {
    idempotency_key: payload.idempotency_key ?? null,
    meeting_id: meeting?.id ?? payload.bot_metadata?.minutesbot_meeting_id ?? null,
    attendee_bot_id: payload.bot_id,
    trigger: payload.trigger,
    event_type: typeof payload.data.event_type === "string" ? payload.data.event_type : null,
    event_sub_type: typeof payload.data.event_sub_type === "string" ? payload.data.event_sub_type : null,
    payload: JSON.stringify(payload),
    processed_at: new Date().toISOString()
  });
  if (!event) return { duplicate: true, meetingId: meeting?.id };
  if (!meeting) return { duplicate: false };

  if (payload.trigger === "bot.state_change") {
    const state = typeof payload.data.new_state === "string" ? payload.data.new_state : undefined;
    await updateMeetingBotState(env.DB, meeting.id, {
      botId: payload.bot_id,
      state,
      transcriptionState: typeof payload.data.transcription_state === "string" ? payload.data.transcription_state : undefined,
      recordingState: typeof payload.data.recording_state === "string" ? payload.data.recording_state : undefined,
      status: mapBotStateToMeetingStatus(state, String(payload.data.event_type ?? ""))
    });
    if (payload.data.event_type === "post_processing_completed") {
      await env.SUMMARY_QUEUE.send({ type: "fetch_transcript", meetingId: meeting.id, botId: payload.bot_id });
    }
  }

  if (payload.trigger === "transcript.update") {
    const transcription = payload.data.transcription;
    const text = typeof transcription === "string" ? transcription : typeof transcription === "object" && transcription ? String((transcription as { transcript?: unknown }).transcript ?? "") : "";
    if (text) {
      await insertTranscriptSegment(env.DB, {
        meeting_id: meeting.id,
        attendee_bot_id: payload.bot_id,
        speaker_name: stringOrNull(payload.data.speaker_name),
        speaker_uuid: stringOrNull(payload.data.speaker_uuid),
        speaker_user_uuid: stringOrNull(payload.data.speaker_user_uuid),
        timestamp_ms: numberOrNull(payload.data.timestamp_ms),
        duration_ms: numberOrNull(payload.data.duration_ms),
        text,
        source: "webhook"
      });
    }
  }

  return { duplicate: false, meetingId: meeting.id };
}

export async function eligibleRecipientCount(env: Env, meetingId: string): Promise<number> {
  const attendees = await listMeetingAttendees(env.DB, meetingId);
  return attendees.filter((attendee) => attendee.summary_eligible).length;
}

function mapBotStateToMeetingStatus(state?: string, eventType?: string) {
  if (eventType === "post_processing_completed") return "BOT_ENDED";
  if (!state) return undefined;
  if (state.includes("waiting")) return "BOT_WAITING_ROOM";
  if (state.includes("record")) return "BOT_RECORDING";
  if (state.includes("join")) return "BOT_JOINED";
  if (state.includes("fatal") || state.includes("error")) return "BOT_FATAL_ERROR";
  if (state.includes("leave")) return "BOT_LEAVING";
  return "BOT_CREATED";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
