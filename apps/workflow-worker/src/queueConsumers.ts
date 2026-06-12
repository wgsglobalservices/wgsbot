import { createAuditLog, getMeeting, getSettings } from "@minutesbot/db";
import { AppError, daysAgoIso, resolveBotBaseUrl } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";
import { fetchAndStoreTranscript } from "./transcriptWorkflow";
import { generateAndSendSummary } from "./summaryWorkflow";
import { cancelMeetingBot, createBotClient, handleCreateBotQueueMessage, monitorBotJoin } from "./botCreation";

const RETRY_DELAY_SECONDS = 60;

type QueueMessageBody = {
  type?: unknown;
  meetingId?: unknown;
  botId?: unknown;
  attempt?: unknown;
  reason?: unknown;
  force?: unknown;
};

export async function handleQueueBatch(batch: MessageBatch<unknown>, env: WorkflowEnv): Promise<void> {
  // Each message is isolated: one poison message must not block or redeliver
  // the rest of the batch. Permanent failures are acked (with an audit log);
  // transient ones are retried with a delay.
  for (const message of batch.messages) {
    try {
      await handleQueueMessage(env, message.body);
      message.ack();
    } catch (error) {
      if (isPermanentQueueError(error)) {
        console.error("queue message dropped", error);
        await recordDroppedMessage(env, message.body, error).catch(() => undefined);
        message.ack();
      } else {
        console.error("queue message will retry", error);
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
    }
  }
}

async function handleQueueMessage(env: WorkflowEnv, rawBody: unknown): Promise<void> {
  if (!rawBody || typeof rawBody !== "object") {
    throw new AppError("INVALID_QUEUE_MESSAGE", "Queue message body is not an object", 400);
  }
  const body = rawBody as QueueMessageBody;
  const type = typeof body.type === "string" ? body.type : "";
  const meetingId = typeof body.meetingId === "string" ? body.meetingId : "";
  const botId = typeof body.botId === "string" ? body.botId : undefined;
  const attempt = typeof body.attempt === "number" ? body.attempt : undefined;

  switch (type) {
    case "create_bot":
      if (!meetingId) throw invalidMessage(type);
      await handleCreateBotQueueMessage(env, meetingId);
      return;
    case "monitor_bot_join":
      if (!meetingId || !botId) throw invalidMessage(type);
      await monitorBotJoin(env, meetingId, botId, attempt);
      return;
    case "cancel_bot":
      if (!meetingId || !botId) throw invalidMessage(type);
      await cancelMeetingBot(env, meetingId, botId, typeof body.reason === "string" ? body.reason : "calendar_cancel");
      return;
    case "fetch_transcript":
      if (!meetingId) throw invalidMessage(type);
      await fetchAndStoreTranscript(env, meetingId, botId, { attempt, force: body.force === true });
      return;
    case "summarize":
      if (!meetingId) throw invalidMessage(type);
      await generateAndSendSummary(env, meetingId);
      return;
    case "delete_attendee_data":
      if (!meetingId) throw invalidMessage(type);
      await deleteBotRuntimeData(env, meetingId);
      return;
    default:
      throw new AppError("INVALID_QUEUE_MESSAGE", `Unknown queue message type: ${type || "(missing)"}`, 400);
  }
}

async function deleteBotRuntimeData(env: WorkflowEnv, meetingId: string): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting?.attendee_bot_id) return;
  const settings = await getSettings(env.DB);
  const client = createBotClient(env, resolveBotBaseUrl(settings.attendee.baseUrl, env.BOT_API_BASE_URL));
  await client.deleteBotData(meeting.attendee_bot_id);
  await createAuditLog(env.DB, {
    eventType: "attendee.delete_data_called",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { botId: meeting.attendee_bot_id }
  });
}

function invalidMessage(type: string): AppError {
  return new AppError("INVALID_QUEUE_MESSAGE", `Queue message of type ${type} is missing required fields`, 400);
}

function isPermanentQueueError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.code === "INVALID_QUEUE_MESSAGE" || error.code === "NOT_FOUND";
  }
  return false;
}

async function recordDroppedMessage(env: WorkflowEnv, body: unknown, error: unknown): Promise<void> {
  await createAuditLog(env.DB, {
    eventType: "invite.ignored",
    resourceType: "queue",
    resourceId: "queue-message",
    metadata: {
      reason: error instanceof Error ? error.message : String(error),
      body: typeof body === "object" ? body : String(body)
    }
  });
}

export async function cleanupOldArtifacts(env: WorkflowEnv): Promise<void> {
  const settings = await getSettings(env.DB);
  const thresholds = {
    raw_invite: daysAgoIso(settings.retention.rawInviteDays),
    recording: daysAgoIso(settings.retention.transcriptDays),
    transcript_text: daysAgoIso(settings.retention.transcriptDays),
    transcript_json: daysAgoIso(settings.retention.transcriptDays),
    transcript_segment: daysAgoIso(settings.retention.transcriptDays),
    summary: daysAgoIso(settings.retention.summaryDays)
  };
  let deleted = 0;
  let failed = 0;
  for (const [type, threshold] of Object.entries(thresholds)) {
    const result = await env.DB.prepare("SELECT id, r2_key FROM artifacts WHERE type = ? AND created_at < ? AND deleted_at IS NULL").bind(type, threshold).all<{ id: string; r2_key: string }>();
    for (const artifact of result.results ?? []) {
      // Per-artifact isolation: one failing delete must not abort the sweep.
      try {
        await env.ARTIFACTS.delete(artifact.r2_key);
        await env.DB.prepare("UPDATE artifacts SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), artifact.id).run();
        deleted += 1;
      } catch (error) {
        failed += 1;
        console.error("retention delete failed", artifact.r2_key, error);
      }
    }
  }

  // Summaries are tracked in their own table (no artifacts row), so purge
  // them directly: R2 object first, then the D1 rows holding summary_json.
  const summaryThreshold = daysAgoIso(settings.retention.summaryDays);
  const expiredSummaries = await env.DB
    .prepare("SELECT id, r2_key FROM summaries WHERE created_at < ?")
    .bind(summaryThreshold)
    .all<{ id: string; r2_key: string | null }>();
  for (const summary of expiredSummaries.results ?? []) {
    try {
      if (summary.r2_key) await env.ARTIFACTS.delete(summary.r2_key);
      await env.DB.prepare("DELETE FROM summaries WHERE id = ?").bind(summary.id).run();
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error("retention summary delete failed", summary.id, error);
    }
  }

  await env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(daysAgoIso(settings.retention.auditLogDays)).run();
  await createAuditLog(env.DB, {
    eventType: "cleanup.completed",
    resourceType: "system",
    resourceId: "retention",
    metadata: { deleted, failed }
  });
}
