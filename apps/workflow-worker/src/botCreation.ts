import { ATTENDEE_WEBHOOK_TRIGGERS, AttendeeClient, AttendeeClientError, type AttendeeBot } from "@minutesbot/attendee-client";
import { claimMeetingBotCreation, createAuditLog, getMeeting, getSettings, listMeetingsDueForBotCreation, updateMeetingBotState, updateMeetingStatus } from "@minutesbot/db";
import { AppError, attendeeWebhookUrl, recordingR2Key, resolveAttendeeBaseUrl, shouldCreateBotNow } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";

const MAX_QUEUE_DELAY_SECONDS = 24 * 60 * 60;

export async function handleCreateBotQueueMessage(env: WorkflowEnv, meetingId: string, options: { force?: boolean } = {}): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  if (meeting.status === "CANCELLED") return;
  if (meeting.attendee_bot_id) return;

  const settings = await getSettings(env.DB);
  if (!options.force && !shouldCreateBotNow(meeting.start_time, settings.attendee.createBotMinutesBeforeStart)) {
    const wakeAt = meeting.start_time ?? new Date().toISOString();
    const delaySeconds = secondsUntil(wakeAt);
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
  if (meeting.attendee_bot_id) return;
  if (!(await claimMeetingBotCreation(env.DB, meetingId))) return;

  const settings = await getSettings(env.DB);
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
      botImage: await loadBotImage(env, settings.attendee.botImage),
      botChatMessage: botJoinChatMessage(settings.attendee.botName),
      recordingSettings: { format: "mp3" },
      externalMediaStorageSettings: {
        bucketName: env.ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME,
        recordingFileName: recordingR2Key(meeting.id)
      },
      webhooks: [
        {
          url: attendeeWebhookUrl(env),
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

export async function queueDueBotCreations(env: WorkflowEnv, now: Date = new Date()): Promise<number> {
  const cutoffIso = now.toISOString();
  const meetings = await listMeetingsDueForBotCreation(env.DB, cutoffIso);
  for (const meeting of meetings) {
    await env.INVITE_QUEUE.send({ type: "create_bot", meetingId: meeting.id });
  }
  return meetings.length;
}

function botJoinChatMessage(botName: string): string {
  return `Hi, I'm ${botName}, an automated WGS meeting notetaker. I record and transcribe this meeting so the team can receive a recap.`;
}

async function loadBotImage(
  env: WorkflowEnv,
  botImage: { r2Key: string; contentType: "image/png" | "image/jpeg" } | undefined
): Promise<{ type: "image/png" | "image/jpeg"; data: string } | undefined> {
  if (!botImage) return undefined;
  const object = await env.ARTIFACTS.get(botImage.r2Key);
  if (!object) return undefined;
  return {
    type: botImage.contentType,
    data: bytesToBase64(new Uint8Array(await object.arrayBuffer()))
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
