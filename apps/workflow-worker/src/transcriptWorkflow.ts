import { AttendeeClient, type AttendeeTranscriptSegment } from "@minutesbot/attendee-client";
import { createArtifact, createAuditLog, getMeeting, getSettings, insertTranscriptSegment, updateTranscriptStatus } from "@minutesbot/db";
import { createOpenRouterTranscriptionProvider } from "@minutesbot/summary-engine";
import { AppError, resolveAttendeeBaseUrl } from "@minutesbot/shared";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string; botId?: string; forceAttendeeFetch?: boolean };

export class TranscriptWorkflow extends WorkflowEntrypoint<WorkflowEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    await fetchAndStoreTranscript(this.env, event.payload.meetingId, event.payload.botId, step.do.bind(step), { forceAttendeeFetch: event.payload.forceAttendeeFetch });
  }
}

export async function fetchAndStoreTranscript(
  env: WorkflowEnv,
  meetingId: string,
  botId?: string,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T> = (_name, callback) => callback(),
  options: { forceAttendeeFetch?: boolean } = {}
): Promise<void> {
  const meeting = await runStep("load meeting", () => getMeeting(env.DB, meetingId));
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  const settings = await runStep("load settings", () => getSettings(env.DB));
  const attendeeBotId = botId ?? meeting.attendee_bot_id;
  if (!attendeeBotId) throw new AppError("BOT_ID_MISSING", "Meeting has no Attendee bot ID", 400);
  if (!env.ATTENDEE_API_KEY) throw new AppError("ATTENDEE_API_KEY_MISSING", "ATTENDEE_API_KEY secret is not configured", 500);

  const client = new AttendeeClient({ baseUrl: resolveAttendeeBaseUrl(settings.attendee.baseUrl, env.ATTENDEE_API_BASE_URL), apiKey: env.ATTENDEE_API_KEY });
  try {
    const attendeeTranscript = await runStep("fetch Attendee transcript", () =>
      options.forceAttendeeFetch ? client.getBotTranscript(attendeeBotId, { force: true }) : client.getBotTranscript(attendeeBotId)
    );
    const attendeeText = await storeAttendeeTranscriptSegments(env.DB, meetingId, attendeeBotId, attendeeTranscript);
    const recording = await fetchAndStoreRecording(env, meetingId, client, attendeeBotId, attendeeText.length > 0, runStep);
    const transcription = attendeeText.length > 0 ? { source: "attendee", model: null, text: attendeeText, usage: null } : await transcribeStoredRecording(env, settings, recording, runStep);
    const plainText = transcription.text.trim();
    if (!plainText) {
      await updateTranscriptStatus(env.DB, meetingId, "unavailable", "NO_TRANSCRIPT_AVAILABLE");
      await createAuditLog(env.DB, { eventType: "transcript.unavailable", resourceType: "meeting", resourceId: meetingId });
      return;
    }

    const jsonBody = JSON.stringify({ source: transcription.source, model: transcription.model, text: plainText, usage: transcription.usage ?? null });
    const jsonKey = `transcripts/${meetingId}/transcript.json`;
    const textKey = `transcripts/${meetingId}/transcript.txt`;
    await env.ARTIFACTS.put(textKey, plainText, { httpMetadata: { contentType: "text/plain" } });
    await env.ARTIFACTS.put(jsonKey, jsonBody, { httpMetadata: { contentType: "application/json" } });
    await createArtifact(env.DB, { meeting_id: meetingId, type: "transcript_text", r2_key: textKey, content_type: "text/plain", size_bytes: byteLength(plainText), deleted_at: null });
    await createArtifact(env.DB, { meeting_id: meetingId, type: "transcript_json", r2_key: jsonKey, content_type: "application/json", size_bytes: byteLength(jsonBody), deleted_at: null });
    await updateTranscriptStatus(env.DB, meetingId, "complete", "TRANSCRIPT_AVAILABLE");
    await createAuditLog(env.DB, { eventType: "transcript.fetched", resourceType: "meeting", resourceId: meetingId, metadata: { source: transcription.source, model: transcription.model } });
    await env.SUMMARY_QUEUE.send({ type: "summarize", meetingId });
    if (settings.attendee.deleteAttendeeDataAfterTranscriptFetch) await client.deleteBotData(attendeeBotId);
  } catch (error) {
    await updateTranscriptStatus(env.DB, meetingId, "failed", "FAILED");
    await createAuditLog(env.DB, {
      eventType: "transcript.failed",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: { reason: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }
}

async function fetchAndStoreRecording(
  env: WorkflowEnv,
  meetingId: string,
  client: AttendeeClient,
  attendeeBotId: string,
  optional: boolean,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T>
) {
  try {
    const recording = await runStep("fetch recording", () => client.getBotRecording(attendeeBotId));
    const recordingKey = `recordings/${meetingId}/recording.${recordingExtension(recording.contentType)}`;
    await env.ARTIFACTS.put(recordingKey, recording.data, { httpMetadata: { contentType: recording.contentType } });
    await createArtifact(env.DB, {
      meeting_id: meetingId,
      type: "recording",
      r2_key: recordingKey,
      content_type: recording.contentType,
      size_bytes: recording.sizeBytes ?? recording.data.byteLength,
      deleted_at: null
    });
    return recording;
  } catch (error) {
    if (!optional) throw error;
    await createAuditLog(env.DB, {
      eventType: "recording.unavailable",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: { reason: error instanceof Error ? error.message : String(error) }
    });
    return null;
  }
}

function requireRecording(recording: Awaited<ReturnType<typeof fetchAndStoreRecording>>) {
  if (!recording) throw new AppError("ATTENDEE_RECORDING_UNAVAILABLE", "Attendee recording media is unavailable", 503);
  return recording;
}

async function transcribeStoredRecording(
  env: WorkflowEnv,
  settings: Awaited<ReturnType<typeof getSettings>>,
  recording: Awaited<ReturnType<typeof fetchAndStoreRecording>>,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T>
) {
  const availableRecording = requireRecording(recording);
  return transcribeRecording(env, settings, availableRecording.data, availableRecording.contentType, runStep);
}

async function transcribeRecording(
  env: WorkflowEnv,
  settings: Awaited<ReturnType<typeof getSettings>>,
  recordingData: ArrayBuffer,
  contentType: string,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T>
) {
  if (!env.AI_API_KEY) throw new AppError("AI_API_KEY_MISSING", "AI_API_KEY secret is not configured", 500);
  const transcriber = createOpenRouterTranscriptionProvider({
    baseUrl: openRouterBaseUrl(settings.ai.baseUrl),
    apiKey: env.AI_API_KEY,
    model: settings.recap.transcriptionModel,
    language: settings.recap.language || undefined
  });
  const transcription = await runStep("transcribe recording", () => transcriber.transcribe(recordingData, contentType));
  return { source: "openrouter", model: settings.recap.transcriptionModel, text: transcription.text, usage: transcription.usage ?? null };
}

async function storeAttendeeTranscriptSegments(db: D1Database, meetingId: string, attendeeBotId: string, segments: AttendeeTranscriptSegment[]): Promise<string> {
  const lines: string[] = [];
  for (const segment of segments) {
    const text = transcriptText(segment).trim();
    if (!text) continue;
    await insertTranscriptSegment(db, {
      meeting_id: meetingId,
      attendee_bot_id: attendeeBotId,
      speaker_name: segment.speaker_name ?? null,
      speaker_uuid: segment.speaker_uuid ?? null,
      speaker_user_uuid: segment.speaker_user_uuid ?? null,
      timestamp_ms: segment.timestamp_ms ?? null,
      duration_ms: segment.duration_ms ?? null,
      text,
      source: "attendee"
    });
    lines.push(segment.speaker_name ? `${segment.speaker_name}: ${text}` : text);
  }
  return lines.join("\n");
}

function transcriptText(segment: AttendeeTranscriptSegment): string {
  const transcription = segment.transcription;
  if (typeof transcription === "string") return transcription;
  return typeof transcription.transcript === "string" ? transcription.transcript : "";
}

function recordingExtension(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "audio/mpeg") return "mp3";
  if (type === "audio/mp4" || type === "audio/x-m4a") return "mp4";
  if (type === "video/mp4") return "mp4";
  if (type === "audio/wav" || type === "audio/wave") return "wav";
  if (type === "audio/webm") return "webm";
  if (type === "audio/ogg") return "ogg";
  return "bin";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function openRouterBaseUrl(configuredBaseUrl?: string): string {
  return configuredBaseUrl && new URL(configuredBaseUrl).hostname === "openrouter.ai" ? configuredBaseUrl : "https://openrouter.ai/api/v1";
}
