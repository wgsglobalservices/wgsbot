import { BOT_WEBHOOK_TRIGGERS, BotClient, BotClientError, type BotRun } from "@minutesbot/bot-client";
import { createAuditLog, getMeeting, getSettings, listWebhookEvents, updateMeetingBotState, updateMeetingStatus, type MeetingRow } from "@minutesbot/db";
import { AppError, botWebhookUrl, mapBotStateToMeetingStatus, minutesBefore, recordingR2Key, resolveBotBaseUrl } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";

const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;
const MAX_UNREACHABLE_MONITOR_ATTEMPTS = 5;

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

  // A meeting with a live (or still pending) bot must not get a second one:
  // calendar updates and redelivered create_bot messages would otherwise
  // spawn duplicate bots that overwrite each other's recording in R2.
  if (meeting.attendee_bot_id && !isSettledBotState(meeting.attendee_bot_state)) {
    await createAuditLog(env.DB, {
      eventType: "bot.create_queued",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: { skipped: "bot already active", botId: meeting.attendee_bot_id, state: meeting.attendee_bot_state }
    });
    return;
  }

  const settings = await getSettings(env.DB);
  const joinTimeoutSeconds = Math.max(60, settings.attendee.maxWaitingRoomMinutes * 60);
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
      joinTimeoutSeconds,
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
  const recordedWebhookState = lifecycleWebhookAlreadyAdvanced ? null : await latestRecordedLifecycleState(env.DB, meetingId, bot.id);
  if (!lifecycleWebhookAlreadyAdvanced) {
    if (recordedWebhookState) {
      await updateMeetingBotState(env.DB, meetingId, recordedWebhookState);
    } else {
      await updateMeetingBotState(env.DB, meetingId, {
        botId: bot.id,
        state: bot.state,
        transcriptionState: bot.transcription_state,
        recordingState: bot.recording_state,
        status: "BOT_CREATED"
      });
    }
  }
  await env.INVITE_QUEUE.send({ type: "monitor_bot_join", meetingId, botId: bot.id }, { delaySeconds: joinTimeoutSeconds });
  await createAuditLog(env.DB, {
    eventType: "bot.created",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { botId: bot.id, state: lifecycleWebhookAlreadyAdvanced ? latestMeeting?.attendee_bot_state : recordedWebhookState?.state ?? bot.state }
  });
}

export async function monitorBotJoin(env: WorkflowEnv, meetingId: string, botId: string, attempt = 0): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting || meeting.attendee_bot_id !== botId || !isStuckJoinState(meeting.attendee_bot_state, meeting.status)) return;

  const settings = await getSettings(env.DB);
  const client = createBotClient(env, resolveBotBaseUrl(settings.attendee.baseUrl, env.BOT_API_BASE_URL));
  // Distinguish "runtime reports a stuck bot" from "runtime unreachable":
  // a transient outage of the bot runtime must not mark a healthy recording
  // bot as fatally failed.
  let runtimeBot: BotRun | null = null;
  let runtimeUnreachable = false;
  try {
    runtimeBot = await client.getBot(botId);
  } catch {
    runtimeUnreachable = true;
  }
  if (runtimeBot) {
    const status = mapBotStateToMeetingStatus(runtimeBot.state, runtimeBot.state === "failed" ? "fatal_error" : "state_change");
    if (runtimeBot.latest_error) {
      await updateMeetingBotState(env.DB, meetingId, {
        botId,
        state: runtimeBot.state === "failed" ? "failed" : runtimeBot.state,
        transcriptionState: runtimeBot.transcription_state ?? (runtimeBot.state === "failed" ? "failed" : undefined),
        recordingState: runtimeBot.recording_state ?? (runtimeBot.state === "failed" ? "failed" : undefined),
        status: runtimeBot.state === "failed" ? "BOT_FATAL_ERROR" : status,
        latestError: runtimeBot.latest_error
      });
      await createAuditLog(env.DB, {
        eventType: runtimeBot.state === "failed" ? "bot.fatal_error" : "bot.state_changed",
        resourceType: "meeting",
        resourceId: meetingId,
        metadata: { botId, source: "monitor", state: runtimeBot.state, latestError: runtimeBot.latest_error }
      });
      return;
    }
    if (!isStuckJoinState(runtimeBot.state, status)) {
      await updateMeetingBotState(env.DB, meetingId, {
        botId,
        state: runtimeBot.state,
        transcriptionState: runtimeBot.transcription_state,
        recordingState: runtimeBot.recording_state,
        status,
        latestError: runtimeBot.latest_error
      });
      await createAuditLog(env.DB, {
        eventType: "bot.state_changed",
        resourceType: "meeting",
        resourceId: meetingId,
        metadata: { botId, source: "monitor", state: runtimeBot.state }
      });
      return;
    }
  }

  if (attempt < 1 || (runtimeUnreachable && attempt < MAX_UNREACHABLE_MONITOR_ATTEMPTS)) {
    await env.INVITE_QUEUE.send({ type: "monitor_bot_join", meetingId, botId, attempt: attempt + 1 }, { delaySeconds: 60 });
    return;
  }

  const latestError = runtimeUnreachable
    ? `Meeting bot runtime was unreachable while monitoring the join after ${attempt + 1} attempts`
    : monitorTimeoutError(runtimeBot?.state ?? meeting.attendee_bot_state, settings.attendee.maxWaitingRoomMinutes);
  await updateMeetingBotState(env.DB, meetingId, {
    botId,
    state: "failed",
    transcriptionState: "failed",
    recordingState: "failed",
    status: "BOT_FATAL_ERROR",
    latestError
  });
  await createAuditLog(env.DB, {
    eventType: "bot.fatal_error",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { botId, reason: latestError, source: "monitor" }
  });
}

export async function cancelMeetingBot(env: WorkflowEnv, meetingId: string, botId: string, reason = "calendar_cancel"): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting || meeting.attendee_bot_id !== botId || isTerminalBotState(meeting.attendee_bot_state, meeting.status)) return;

  await createAuditLog(env.DB, {
    eventType: "bot.cancel_requested",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { botId, reason }
  });

  try {
    const settings = await getSettings(env.DB);
    const client = createBotClient(env, resolveBotBaseUrl(settings.attendee.baseUrl, env.BOT_API_BASE_URL));
    const runtimeBot = await client.cancelBot(botId);
    await updateMeetingBotState(env.DB, meetingId, {
      botId,
      state: runtimeBot.state,
      transcriptionState: runtimeBot.transcription_state,
      recordingState: runtimeBot.recording_state,
      status: mapBotStateToMeetingStatus(runtimeBot.state, runtimeBot.state === "cancelled" ? "cancelled" : "cancel_requested"),
      latestError: runtimeBot.latest_error
    });
    await createAuditLog(env.DB, {
      eventType: "bot.cancelled",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: { botId, reason, state: runtimeBot.state }
    });
  } catch (error) {
    const latestError = error instanceof Error ? error.message : String(error);
    await updateMeetingBotState(env.DB, meetingId, {
      botId,
      status: "BOT_LEAVING",
      latestError
    });
    await createAuditLog(env.DB, {
      eventType: "bot.cancel_failed",
      resourceType: "meeting",
      resourceId: meetingId,
      metadata: { botId, reason, error: latestError }
    });
    throw error;
  }
}

export function createBotClient(env: Pick<WorkflowEnv, "BOT_INTERNAL_TOKEN" | "BOT_RUNTIME">, baseUrl: string): BotClient {
  return new BotClient({
    baseUrl,
    internalToken: env.BOT_INTERNAL_TOKEN,
    fetcher: env.BOT_RUNTIME ? (input, init) => env.BOT_RUNTIME!.fetch(input, init) : undefined
  });
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

async function latestRecordedLifecycleState(
  db: D1Database,
  meetingId: string,
  botId: string
): Promise<Parameters<typeof updateMeetingBotState>[2] | null> {
  const events = await listWebhookEvents(db, meetingId);
  for (const event of events) {
    if (event.attendee_bot_id !== botId || event.trigger !== "bot.state_change") continue;
    const payload = typeof event.payload === "string" ? parseJsonObject(event.payload) : null;
    const data = payload && typeof payload.data === "object" && payload.data ? payload.data as Record<string, unknown> : null;
    if (!data) continue;
    const state = stringOrUndefined(data.new_state);
    const eventType = stringOrUndefined(data.event_type);
    return {
      botId,
      state,
      transcriptionState: stringOrUndefined(data.transcription_state),
      recordingState: stringOrUndefined(data.recording_state),
      status: mapBotStateToMeetingStatus(state, eventType),
      latestError: stringOrUndefined(data.latest_error)
    };
  }
  return null;
}

// Deliberately narrower than the shared isTerminalBotState: a meeting whose
// *status* is already CANCELLED can still have a live bot that this worker
// must cancel (the email worker marks the meeting cancelled before queueing
// cancel_bot), so only bot-side states count here.
function isTerminalBotState(state?: string | null, status?: MeetingRow["status"]): boolean {
  if (status && ["BOT_ENDED", "SUMMARY_SENT", "BOT_FATAL_ERROR", "FAILED"].includes(status)) return true;
  return isSettledBotState(state);
}

function isSettledBotState(state?: string | null): boolean {
  return state === "ended" || state === "failed" || state === "cancelled";
}

function isStuckJoinState(state?: string | null, status?: MeetingRow["status"]): boolean {
  if (status && !["BOT_JOINING", "BOT_WAITING_ROOM", "BOT_CREATED", "BOT_CREATE_QUEUED"].includes(status)) return false;
  return !state || ["queued", "prejoin", "joining", "waiting_room"].includes(state);
}

function monitorTimeoutError(state: string | null | undefined, minutes: number): string {
  if (state === "prejoin") return `Meeting bot remained on the Teams pre-join screen after the ${minutes} minute join timeout expired`;
  if (state === "waiting_room") return `Meeting bot remained in the Teams lobby after the ${minutes} minute waiting room timeout expired`;
  if (state === "queued") return `Meeting bot remained queued after the ${minutes} minute join timeout expired`;
  return `Meeting bot remained in ${state ?? "joining"} after the ${minutes} minute join timeout expired`;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
