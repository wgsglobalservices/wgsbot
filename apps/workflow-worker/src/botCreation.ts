import { ATTENDEE_WEBHOOK_TRIGGERS, AttendeeClient, AttendeeClientError, type AttendeeBot } from "@minutesbot/attendee-client";
import { createAuditLog, getMeeting, getSettings, updateMeetingBotState, updateMeetingStatus } from "@minutesbot/db";
import { AppError, minutesBefore, recordingR2Key, resolveAttendeeBaseUrl } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";

const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

export async function handleCreateBotQueueMessage(env: WorkflowEnv, meetingId: string): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  if (meeting.status === "CANCELLED") return;

  const settings = await getSettings(env.DB);
  const wakeAt = minutesBefore(meeting.start_time ?? new Date().toISOString(), settings.attendee.createBotMinutesBeforeStart);
  const delaySeconds = secondsUntil(wakeAt);
  if (delaySeconds > 0) {
    await env.INVITE_QUEUE.send({ type: "create_bot", meetingId }, { delaySeconds: Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS) });
    await updateMeetingStatus(env.DB, meetingId, "WAITING_TO_CREATE_BOT");
    return;
  }

  await createMeetingBot(env, meetingId);
}

export async function createMeetingBot(env: WorkflowEnv, meetingId: string): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  if (meeting.status === "CANCELLED") return;

  const settings = await getSettings(env.DB);
  await updateMeetingStatus(env.DB, meetingId, "BOT_CREATE_QUEUED");
  await createAuditLog(env.DB, { eventType: "bot.create_queued", resourceType: "meeting", resourceId: meetingId });

  let bot: AttendeeBot;
  try {
    if (!env.ATTENDEE_API_KEY) throw new AppError("ATTENDEE_API_KEY_MISSING", "ATTENDEE_API_KEY secret is not configured", 500);
    if (!env.ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME) {
      throw new AppError("ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME_MISSING", "ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME is not configured", 500);
    }
    const client = new AttendeeClient({ baseUrl: resolveAttendeeBaseUrl(settings.attendee.baseUrl, env.ATTENDEE_API_BASE_URL), apiKey: env.ATTENDEE_API_KEY });
    await client.checkHealth();
    bot = await client.createBot({
      meetingUrl: meeting.teams_join_url ?? "",
      botName: settings.attendee.botName,
      recordingSettings: { format: "mp3" },
      externalMediaStorageSettings: {
        bucketName: env.ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME,
        recordingFileName: recordingR2Key(meeting.id)
      },
      webhooks: [
        {
          url: `${env.API_BASE_URL}/api/webhooks/attendee`,
          triggers: [...ATTENDEE_WEBHOOK_TRIGGERS]
        }
      ],
      metadata: { minutesbot_meeting_id: meeting.id, calendar_uid: meeting.calendar_uid }
    });
  } catch (error) {
    const failure = botCreationFailure(error);
    await updateMeetingStatus(env.DB, meetingId, "FAILED", failure.latestError);
    await createAuditLog(env.DB, {
      eventType: "bot.fatal_error",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: failure.auditMetadata
    });
    throw error;
  }

  await updateMeetingBotState(env.DB, meetingId, {
    botId: bot.id,
    state: bot.state,
    transcriptionState: bot.transcription_state,
    recordingState: bot.recording_state,
    status: "BOT_CREATED"
  });
  await createAuditLog(env.DB, { eventType: "bot.created", resourceType: "meeting", resourceId: meetingId, metadata: { botId: bot.id, state: bot.state } });
}

function secondsUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));
}

function botCreationFailure(error: unknown): { latestError: string; auditMetadata: Record<string, unknown> } {
  if (error instanceof AttendeeClientError) {
    return {
      latestError: `${error.code}: ${error.message}`,
      auditMetadata: { code: error.code, status: error.status, retryable: error.retryable }
    };
  }
  if (error instanceof AppError) {
    return {
      latestError: `${error.code}: ${error.message}`,
      auditMetadata: { code: error.code }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    latestError: `ATTENDEE_CREATE_FAILED: ${message}`,
    auditMetadata: { code: "ATTENDEE_CREATE_FAILED", message }
  };
}
