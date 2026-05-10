import { createAuditLog, getSettings } from "@minutesbot/db";
import { daysAgoIso } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";
import { fetchAndStoreTranscript } from "./transcriptWorkflow";
import { generateAndSendSummary } from "./summaryWorkflow";
import { handleCreateBotQueueMessage, monitorBotJoin } from "./botCreation";

export async function handleQueueBatch(batch: MessageBatch<unknown>, env: WorkflowEnv): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as { type?: string; meetingId?: string; botId?: string; attempt?: number };
    if (body.type === "create_bot" && body.meetingId) await handleCreateBotQueueMessage(env, body.meetingId);
    if (body.type === "monitor_bot_join" && body.meetingId && body.botId) await monitorBotJoin(env, body.meetingId, body.botId);
    if (body.type === "fetch_transcript" && body.meetingId) await fetchAndStoreTranscript(env, body.meetingId, body.botId, undefined, { attempt: body.attempt });
    if (body.type === "summarize" && body.meetingId) await generateAndSendSummary(env, body.meetingId);
    message.ack();
  }
}

export async function cleanupOldArtifacts(env: WorkflowEnv): Promise<void> {
  const settings = await getSettings(env.DB);
  const thresholds = {
    raw_invite: daysAgoIso(settings.retention.rawInviteDays),
    recording: daysAgoIso(settings.retention.transcriptDays),
    transcript_text: daysAgoIso(settings.retention.transcriptDays),
    transcript_json: daysAgoIso(settings.retention.transcriptDays),
    summary: daysAgoIso(settings.retention.summaryDays)
  };
  for (const [type, threshold] of Object.entries(thresholds)) {
    const result = await env.DB.prepare("SELECT id, r2_key FROM artifacts WHERE type = ? AND created_at < ? AND deleted_at IS NULL").bind(type, threshold).all<{ id: string; r2_key: string }>();
    for (const artifact of result.results ?? []) {
      await env.ARTIFACTS.delete(artifact.r2_key);
      await env.DB.prepare("UPDATE artifacts SET deleted_at = ? WHERE id = ?").bind(new Date().toISOString(), artifact.id).run();
    }
  }
  await env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(daysAgoIso(settings.retention.auditLogDays)).run();
  await createAuditLog(env.DB, { eventType: "cleanup.completed", resourceType: "system", resourceId: "retention" });
}
