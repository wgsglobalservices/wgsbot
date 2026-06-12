import {
  createArtifact,
  findMeetingByBot,
  getMeeting,
  insertWebhookEvent,
  listMeetingAttendees,
  updateMeetingBotState,
  updateMeetingStatus
} from "@minutesbot/db";
import type { BotWebhookTrigger } from "@minutesbot/bot-client";
import { createId } from "@minutesbot/shared";
import type { Env } from "../env";

export type BotWebhookPayload = {
  idempotency_key?: string;
  bot_id: string;
  bot_metadata?: { minutesbot_meeting_id?: string; calendar_uid?: string };
  trigger: BotWebhookTrigger;
  data: Record<string, unknown>;
};

export async function processBotWebhook(env: Env, payload: BotWebhookPayload): Promise<{ duplicate: boolean; meetingId?: string }> {
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
  if (!meeting) return { duplicate: !event };

  if (payload.trigger === "bot.state_change") {
    await applyBotStateChange(env, meeting.id, payload);
    if (event && payload.data.event_type === "post_processing_completed") {
      await env.SUMMARY_QUEUE.send({ type: "fetch_transcript", meetingId: meeting.id, botId: payload.bot_id });
    }
  }

  if (event && payload.trigger === "transcript.update") {
    const transcription = payload.data.transcription;
    const text = typeof transcription === "string" ? transcription : typeof transcription === "object" && transcription ? String((transcription as { transcript?: unknown }).transcript ?? "") : "";
    if (text) {
      await storeWebhookTranscriptSegment(env, meeting.id, payload, text);
    }
  }

  return { duplicate: !event, meetingId: meeting.id };
}

async function storeWebhookTranscriptSegment(env: Env, meetingId: string, payload: BotWebhookPayload, text: string): Promise<void> {
  const segmentId = createId("seg");
  const body = JSON.stringify({
    id: segmentId,
    meeting_id: meetingId,
    attendee_bot_id: payload.bot_id,
    speaker_name: stringOrNull(payload.data.speaker_name),
    speaker_uuid: stringOrNull(payload.data.speaker_uuid),
    speaker_user_uuid: stringOrNull(payload.data.speaker_user_uuid),
    timestamp_ms: numberOrNull(payload.data.timestamp_ms),
    duration_ms: numberOrNull(payload.data.duration_ms),
    text,
    source: "webhook"
  });
  const r2Key = `transcript-segments/${meetingId}/${segmentId}.json`;
  await env.ARTIFACTS.put(r2Key, body, { httpMetadata: { contentType: "application/json" } });
  await createArtifact(env.DB, {
    meeting_id: meetingId,
    type: "transcript_segment",
    r2_key: r2Key,
    content_type: "application/json",
    size_bytes: new TextEncoder().encode(body).byteLength,
    deleted_at: null
  });
}

export const processAttendeeWebhook = processBotWebhook;

export async function eligibleRecipientCount(env: Env, meetingId: string): Promise<number> {
  const attendees = await listMeetingAttendees(env.DB, meetingId);
  return attendees.filter((attendee) => attendee.summary_eligible).length;
}

function mapBotStateToMeetingStatus(state?: string, eventType?: string) {
  if (eventType === "post_processing_completed") return "BOT_ENDED";
  if (eventType === "cancelled" || state === "cancelled") return "CANCELLED";
  if (eventType === "cancel_requested" || state === "cancelling") return "BOT_LEAVING";
  if (eventType === "fatal_error") return "BOT_FATAL_ERROR";
  if (!state) return undefined;
  if (state === "failed" || state.includes("fatal") || state.includes("error")) return "BOT_FATAL_ERROR";
  if (state === "prejoin" || state === "joining") return "BOT_JOINING";
  if (state.includes("waiting")) return "BOT_WAITING_ROOM";
  if (state === "joined") return "BOT_JOINED";
  if (state.includes("record")) return "BOT_RECORDING";
  if (state.includes("post_processing")) return "BOT_POST_PROCESSING";
  if (state === "ended") return "BOT_ENDED";
  if (state.includes("leave")) return "BOT_LEAVING";
  return "BOT_CREATED";
}

async function applyBotStateChange(env: Env, meetingId: string, payload: BotWebhookPayload): Promise<void> {
  const state = typeof payload.data.new_state === "string" ? payload.data.new_state : undefined;
  await updateMeetingBotState(env.DB, meetingId, {
    botId: payload.bot_id,
    state,
    transcriptionState: typeof payload.data.transcription_state === "string" ? payload.data.transcription_state : undefined,
    recordingState: typeof payload.data.recording_state === "string" ? payload.data.recording_state : undefined,
    status: mapBotStateToMeetingStatus(state, String(payload.data.event_type ?? "")),
    latestError: typeof payload.data.latest_error === "string" ? payload.data.latest_error : undefined
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}
