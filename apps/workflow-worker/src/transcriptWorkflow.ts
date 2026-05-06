import { AttendeeClient } from "@minutesbot/attendee-client";
import { createArtifact, createAuditLog, getMeeting, getSettings, insertTranscriptSegment, updateTranscriptStatus } from "@minutesbot/db";
import { AppError, resolveAttendeeBaseUrl } from "@minutesbot/shared";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string; botId?: string };

export class TranscriptWorkflow extends WorkflowEntrypoint<WorkflowEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    await fetchAndStoreTranscript(this.env, event.payload.meetingId, event.payload.botId, step.do.bind(step));
  }
}

export async function fetchAndStoreTranscript(
  env: WorkflowEnv,
  meetingId: string,
  botId?: string,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T> = (_name, callback) => callback()
): Promise<void> {
  const meeting = await runStep("load meeting", () => getMeeting(env.DB, meetingId));
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  const settings = await runStep("load settings", () => getSettings(env.DB));
  const attendeeBotId = botId ?? meeting.attendee_bot_id;
  if (!attendeeBotId) throw new AppError("BOT_ID_MISSING", "Meeting has no Attendee bot ID", 400);
  if (!env.ATTENDEE_API_KEY) throw new AppError("ATTENDEE_API_KEY_MISSING", "ATTENDEE_API_KEY secret is not configured", 500);

  const client = new AttendeeClient({ baseUrl: resolveAttendeeBaseUrl(settings.attendee.baseUrl, env.ATTENDEE_API_BASE_URL), apiKey: env.ATTENDEE_API_KEY });
  const transcript = await runStep("fetch transcript", () => client.getBotTranscript(attendeeBotId));
  if (transcript.length === 0) {
    await updateTranscriptStatus(env.DB, meetingId, "unavailable", "NO_TRANSCRIPT_AVAILABLE");
    await createAuditLog(env.DB, { eventType: "transcript.unavailable", resourceType: "meeting", resourceId: meetingId });
    return;
  }
  const plainText = transcript.map((segment) => `${segment.speaker_name ?? "Speaker"}: ${typeof segment.transcription === "string" ? segment.transcription : segment.transcription.transcript ?? ""}`).join("\n");
  const jsonKey = `transcripts/${meetingId}/transcript.json`;
  const textKey = `transcripts/${meetingId}/transcript.txt`;
  await env.ARTIFACTS.put(jsonKey, JSON.stringify(transcript), { httpMetadata: { contentType: "application/json" } });
  await env.ARTIFACTS.put(textKey, plainText, { httpMetadata: { contentType: "text/plain" } });
  await createArtifact(env.DB, { meeting_id: meetingId, type: "transcript_json", r2_key: jsonKey, content_type: "application/json", size_bytes: JSON.stringify(transcript).length, deleted_at: null });
  await createArtifact(env.DB, { meeting_id: meetingId, type: "transcript_text", r2_key: textKey, content_type: "text/plain", size_bytes: plainText.length, deleted_at: null });
  for (const segment of transcript) {
    const text = typeof segment.transcription === "string" ? segment.transcription : segment.transcription.transcript ?? "";
    if (text) {
      await insertTranscriptSegment(env.DB, {
        meeting_id: meetingId,
        attendee_bot_id: attendeeBotId,
        speaker_name: segment.speaker_name ?? null,
        speaker_uuid: segment.speaker_uuid ?? null,
        speaker_user_uuid: segment.speaker_user_uuid ?? null,
        timestamp_ms: segment.timestamp_ms ?? null,
        duration_ms: segment.duration_ms ?? null,
        text,
        source: "fetch"
      });
    }
  }
  await updateTranscriptStatus(env.DB, meetingId, "complete", "TRANSCRIPT_AVAILABLE");
  await createAuditLog(env.DB, { eventType: "transcript.fetched", resourceType: "meeting", resourceId: meetingId });
  await env.SUMMARY_QUEUE.send({ type: "summarize", meetingId });
  if (settings.attendee.deleteAttendeeDataAfterTranscriptFetch) await client.deleteBotData(attendeeBotId);
}
