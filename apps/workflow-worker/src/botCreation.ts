import { BOT_WEBHOOK_TRIGGERS, BotClient, BotClientError, type BotRun } from "@minutesbot/bot-client";
import { createAuditLog, getMeeting, getSettings, updateMeetingBotState, updateMeetingStatus, type MeetingRow } from "@minutesbot/db";
import { AppError, botWebhookUrl, minutesBefore, recordingR2Key, resolveBotBaseUrl } from "@minutesbot/shared";
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

  let bot: BotRun;
  try {
    if (!env.BOT_RECORDING_BUCKET_NAME) {
      throw new AppError("BOT_RECORDING_BUCKET_NAME_MISSING", "BOT_RECORDING_BUCKET_NAME is not configured", 500);
    }
    const client = createBotClient(env, resolveBotBaseUrl(settings.attendee.baseUrl, env.BOT_API_BASE_URL));
    await client.checkHealth();
    bot = await client.createBot({
      meetingUrl: meeting.teams_join_url ?? "",
      botName: settings.attendee.botName,
      botImage: await loadBotImage(env, settings.attendee.botImage),
      botChatMessage: botJoinChatMessage(settings.attendee.botName),
      recordingSettings: { format: "mp3" },
      externalMediaStorageSettings: {
        bucketName: env.BOT_RECORDING_BUCKET_NAME,
        recordingFileName: recordingR2Key(meeting.id)
      },
      webhooks: [
        {
          url: botWebhookUrl(env),
          triggers: [...BOT_WEBHOOK_TRIGGERS]
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

  const latestMeeting = await getMeeting(env.DB, meetingId);
  const lifecycleWebhookAlreadyAdvanced = hasLifecycleWebhookState(latestMeeting, bot);
  if (!lifecycleWebhookAlreadyAdvanced) {
    await updateMeetingBotState(env.DB, meetingId, {
      botId: bot.id,
      state: bot.state,
      transcriptionState: bot.transcription_state,
      recordingState: bot.recording_state,
      status: "BOT_CREATED"
    });
  }
  await createAuditLog(env.DB, {
    eventType: "bot.created",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { botId: bot.id, state: lifecycleWebhookAlreadyAdvanced ? latestMeeting?.attendee_bot_state : bot.state }
  });
}

export function createBotClient(env: Pick<WorkflowEnv, "BOT_INTERNAL_TOKEN" | "BOT_RUNTIME">, baseUrl: string): BotClient {
  return new BotClient({
    baseUrl,
    internalToken: env.BOT_INTERNAL_TOKEN,
    fetcher: env.BOT_RUNTIME ? (input, init) => env.BOT_RUNTIME!.fetch(input, init) : undefined
  });
}

function botJoinChatMessage(botName: string): string {
  return `Hi, I'm ${botName}, an automated meeting notetaker. I record and transcribe this meeting so the team can receive a recap.`;
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

function hasLifecycleWebhookState(meeting: MeetingRow | null, bot: BotRun): boolean {
  if (meeting?.attendee_bot_id !== bot.id || !meeting.attendee_bot_state) return false;
  return meeting.attendee_bot_state !== bot.state || !["BOT_CREATE_QUEUED", "BOT_CREATED"].includes(meeting.status);
}

function botCreationFailure(error: unknown): { latestError: string; auditMetadata: Record<string, unknown> } {
  if (error instanceof BotClientError) {
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
    latestError: `BOT_CREATE_FAILED: ${message}`,
    auditMetadata: { code: "BOT_CREATE_FAILED", message }
  };
}
