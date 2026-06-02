import { AttendeeClient } from "@minutesbot/attendee-client";
import { createAuditLog, getMeeting, getSettings, listTranscriptSegments, updateTranscriptStatus, upsertArtifact } from "@minutesbot/db";
import { createOpenRouterTranscriptionProvider } from "@minutesbot/summary-engine";
import { AppError, recordingR2Key, resolveAttendeeBaseUrl } from "@minutesbot/shared";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string; botId?: string; attempt?: number };

const RECORDING_RETRY_DELAY_SECONDS = 60;
const MAX_RECORDING_FETCH_ATTEMPTS = 10;
const maxRecordingBytes = 100 * 1024 * 1024;

type TranscriptResult = {
  source: string;
  model: string;
  text: string;
  usage?: unknown;
};

export class TranscriptWorkflow extends WorkflowEntrypoint<WorkflowEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    await fetchAndStoreTranscript(this.env, event.payload.meetingId, event.payload.botId, step.do.bind(step), { attempt: event.payload.attempt });
  }
}

export async function fetchAndStoreTranscript(
  env: WorkflowEnv,
  meetingId: string,
  botId?: string,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T> = (_name, callback) => callback(),
  options: { attempt?: number } = {}
): Promise<void> {
  const meeting = await runStep("load meeting", () => getMeeting(env.DB, meetingId));
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  const settings = await runStep("load settings", () => getSettings(env.DB));
  const attendeeBotId = botId ?? meeting.attendee_bot_id;
  const recordingKey = recordingR2Key(meetingId);
  try {
    const recordingObject = await runStep("load R2 recording", () => env.ARTIFACTS.get(recordingKey));
    if (recordingObject) {
      const recordingType = recordingContentType(recordingObject, recordingKey);
      if (recordingType) {
        await recordRecordingArtifact(env, meetingId, recordingKey, recordingType, recordingObject.size, runStep);
      }
    }

    const storedTranscript = await transcriptFromStoredSegments(env.DB, meetingId);
    if (storedTranscript) {
      await storeTranscriptAndQueueSummary(env, meetingId, storedTranscript);
      if (settings.attendee.deleteAttendeeDataAfterTranscriptFetch && attendeeBotId) await deleteAttendeeData(env, settings, attendeeBotId);
      return;
    }

    if (!recordingObject) {
      await handleMissingRecording(env, meetingId, attendeeBotId ?? undefined, recordingKey, options.attempt ?? 0);
      return;
    }

    const contentType = recordingContentType(recordingObject, recordingKey);
    if (recordingObject.size > maxRecordingBytes) {
      throw new AppError("RECORDING_TOO_LARGE", "Recording artifact is too large to transcribe automatically.", 413);
    }
    if (!contentType) {
      await updateTranscriptStatus(env.DB, meetingId, "unavailable", "NO_TRANSCRIPT_AVAILABLE");
      await createAuditLog(env.DB, {
        eventType: "transcript.unavailable",
        resourceType: "meeting",
        resourceId: meetingId,
        metadata: { reason: `R2 recording media is unavailable; received ${recordingObject.httpMetadata?.contentType ?? "unknown"}`, recordingKey }
      });
      return;
    }

    const recordingData = await runStep("read R2 recording", () => recordingObject.arrayBuffer());
    const transcription = await transcribeRecording(env, settings, recordingData, contentType, runStep);
    const plainText = transcription.text.trim();
    if (!plainText) {
      await updateTranscriptStatus(env.DB, meetingId, "unavailable", "NO_TRANSCRIPT_AVAILABLE");
      await createAuditLog(env.DB, { eventType: "transcript.unavailable", resourceType: "meeting", resourceId: meetingId });
      return;
    }

    await storeTranscriptAndQueueSummary(env, meetingId, { ...transcription, text: plainText });
    if (settings.attendee.deleteAttendeeDataAfterTranscriptFetch && attendeeBotId) await deleteAttendeeData(env, settings, attendeeBotId);
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

async function handleMissingRecording(env: WorkflowEnv, meetingId: string, attendeeBotId: string | undefined, recordingKey: string, attempt: number): Promise<void> {
  if (attempt >= MAX_RECORDING_FETCH_ATTEMPTS) {
    await updateTranscriptStatus(env.DB, meetingId, "unavailable", "NO_TRANSCRIPT_AVAILABLE");
    await createAuditLog(env.DB, {
      eventType: "transcript.unavailable",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: { reason: "R2 recording is not available", recordingKey, attempts: attempt }
    });
    return;
  }

  const nextAttempt = attempt + 1;
  await createAuditLog(env.DB, {
    eventType: "transcript.recording_pending",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { recordingKey, attempt: nextAttempt, maxAttempts: MAX_RECORDING_FETCH_ATTEMPTS }
  });
  await env.SUMMARY_QUEUE.send(
    {
      type: "fetch_transcript",
      meetingId,
      ...(attendeeBotId ? { botId: attendeeBotId } : {}),
      attempt: nextAttempt
    },
    { delaySeconds: RECORDING_RETRY_DELAY_SECONDS }
  );
}

async function recordRecordingArtifact(
  env: WorkflowEnv,
  meetingId: string,
  recordingKey: string,
  contentType: string,
  sizeBytes: number,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T>
): Promise<void> {
  await runStep("record recording artifact", () =>
    upsertArtifact(env.DB, {
      meeting_id: meetingId,
      type: "recording",
      r2_key: recordingKey,
      content_type: contentType,
      size_bytes: sizeBytes,
      deleted_at: null
    })
  );
}

async function transcriptFromStoredSegments(db: D1Database, meetingId: string): Promise<TranscriptResult | null> {
  const segments = await listTranscriptSegments(db, meetingId);
  const lines = segments
    .map((segment) => ({
      speaker: cleanSpeakerName(segment.speaker_name),
      text: cleanSegmentText(segment.text),
      timestampMs: typeof segment.timestamp_ms === "number" ? segment.timestamp_ms : Number.POSITIVE_INFINITY,
      createdAt: typeof segment.created_at === "string" ? segment.created_at : ""
    }))
    .filter((segment) => segment.text)
    .sort((a, b) => a.timestampMs - b.timestampMs || a.createdAt.localeCompare(b.createdAt))
    .map((segment) => `${segment.speaker}: ${segment.text}`);
  if (lines.length === 0) return null;
  return {
    source: "attendee-webhook",
    model: "attendee-live-transcript",
    text: lines.join("\n"),
    usage: { segments: lines.length }
  };
}

async function storeTranscriptAndQueueSummary(env: WorkflowEnv, meetingId: string, transcript: TranscriptResult): Promise<void> {
  const plainText = transcript.text.trim();
  const jsonBody = JSON.stringify({ source: transcript.source, model: transcript.model, text: plainText, usage: transcript.usage ?? null });
  const jsonKey = `transcripts/${meetingId}/transcript.json`;
  const textKey = `transcripts/${meetingId}/transcript.txt`;
  await env.ARTIFACTS.put(textKey, plainText, { httpMetadata: { contentType: "text/plain" } });
  await env.ARTIFACTS.put(jsonKey, jsonBody, { httpMetadata: { contentType: "application/json" } });
  await upsertArtifact(env.DB, { meeting_id: meetingId, type: "transcript_text", r2_key: textKey, content_type: "text/plain", size_bytes: byteLength(plainText), deleted_at: null });
  await upsertArtifact(env.DB, { meeting_id: meetingId, type: "transcript_json", r2_key: jsonKey, content_type: "application/json", size_bytes: byteLength(jsonBody), deleted_at: null });
  await updateTranscriptStatus(env.DB, meetingId, "complete", "TRANSCRIPT_AVAILABLE");
  await createAuditLog(env.DB, { eventType: "transcript.fetched", resourceType: "meeting", resourceId: meetingId, metadata: { source: transcript.source, model: transcript.model } });
  await env.SUMMARY_QUEUE.send({ type: "summarize", meetingId });
}

export async function deleteAttendeeData(
  env: WorkflowEnv,
  settings: Awaited<ReturnType<typeof getSettings>>,
  attendeeBotId: string
): Promise<void> {
  if (!env.ATTENDEE_API_KEY) throw new AppError("ATTENDEE_API_KEY_MISSING", "ATTENDEE_API_KEY secret is not configured", 500);
  const client = new AttendeeClient({ baseUrl: resolveAttendeeBaseUrl(settings.attendee.baseUrl, env.ATTENDEE_API_BASE_URL), apiKey: env.ATTENDEE_API_KEY, fetcher: env.ATTENDEE_FETCHER });
  await client.deleteBotData(attendeeBotId);
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

function recordingContentType(recordingObject: R2ObjectBody, recordingKey: string): string | null {
  const explicitType = recordingObject.httpMetadata?.contentType?.split(";")[0]?.trim().toLowerCase();
  if (!explicitType) return inferContentType(recordingKey);
  if (explicitType === "application/octet-stream") return inferContentType(recordingKey) ?? explicitType;
  if (explicitType.startsWith("audio/") || explicitType.startsWith("video/")) return explicitType;
  return null;
}

function inferContentType(key: string): string | null {
  if (key.toLowerCase().endsWith(".mp3")) return "audio/mpeg";
  return null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cleanSpeakerName(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "Speaker";
}

function cleanSegmentText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function openRouterBaseUrl(configuredBaseUrl?: string): string {
  return configuredBaseUrl && new URL(configuredBaseUrl).hostname === "openrouter.ai" ? configuredBaseUrl : "https://openrouter.ai/api/v1";
}
