import {
  createAuditLog,
  createJob,
  getBotSession,
  getOccurrence,
  getSettings,
  insertBotEvent,
  touchBotSessionHeartbeat,
  updateBotSessionState,
  updateOccurrenceStatus,
  upsertArtifact
} from "@minutesbot/db";
import type { BotWebhookPayload } from "@minutesbot/bot-client";
import {
  botEventPayloadKey,
  isBotSessionState,
  mapBotStateToOccurrenceStatus,
  nowIso,
  sha256Hex,
  type BotSessionState
} from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";
import { maybeRetryJoin } from "./jobHandlers";

const INLINE_PAYLOAD_LIMIT = 8 * 1024;

export type WebhookProcessResult =
  | { ok: true; duplicate?: boolean }
  | { ok: false; reason: "unknown_session" | "superseded_session" | "invalid_state" };

/**
 * Applies one bot runtime webhook to the data model. Idempotent by the
 * payload's idempotency key; events from superseded runtime bots are
 * ignored so a zombie container cannot corrupt a newer session.
 */
export async function processBotWebhook(env: WorkflowEnv, payload: BotWebhookPayload): Promise<WebhookProcessResult> {
  const session = await getBotSession(env.DB, payload.botSessionId);
  if (!session) return { ok: false, reason: "unknown_session" };
  if (session.runtime_bot_id && payload.runtimeBotId && session.runtime_bot_id !== payload.runtimeBotId) {
    return { ok: false, reason: "superseded_session" };
  }

  const rawPayload = JSON.stringify(payload);
  const payloadHash = await sha256Hex(rawPayload);
  let inlinePayload: string | null = rawPayload;
  let payloadR2Key: string | null = null;

  const eventRow = await insertBotEvent(env.DB, {
    botSessionId: session.id,
    eventType: payload.eventType,
    state: payload.state ?? null,
    payloadHash,
    payload: rawPayload.length <= INLINE_PAYLOAD_LIMIT ? inlinePayload : null,
    payloadR2Key: null,
    idempotencyKey: payload.idempotencyKey
  });
  if (!eventRow) return { ok: true, duplicate: true };

  if (rawPayload.length > INLINE_PAYLOAD_LIMIT) {
    payloadR2Key = botEventPayloadKey(session.id, eventRow.id);
    await env.ARTIFACTS.put(payloadR2Key, rawPayload, { httpMetadata: { contentType: "application/json" } });
    await env.DB.prepare("UPDATE bot_events SET payload_r2_key = ? WHERE id = ?").bind(payloadR2Key, eventRow.id).run();
    await upsertArtifact(env.DB, {
      ownerType: "bot_session",
      ownerId: session.id,
      kind: "bot_event_payload",
      r2Key: payloadR2Key,
      contentType: "application/json",
      sizeBytes: rawPayload.length,
      sha256: payloadHash
    });
    inlinePayload = null;
  }

  if (payload.eventType === "heartbeat" || payload.eventType === "log") {
    await touchBotSessionHeartbeat(env.DB, session.id);
    return { ok: true };
  }

  if (!payload.state || !isBotSessionState(payload.state)) {
    return { ok: false, reason: "invalid_state" };
  }
  const state = payload.state as BotSessionState;

  await updateBotSessionState(env.DB, session.id, {
    state,
    failureStage: payload.failureStage ?? null,
    failureReason: payload.failureReason ?? null,
    recordingR2Key: payload.recordingKey ?? null
  });

  // Diagnostics uploaded by the runtime become first-class artifacts.
  for (const key of payload.diagnosticsKeys ?? []) {
    await upsertArtifact(env.DB, {
      ownerType: "bot_session",
      ownerId: session.id,
      kind: diagnosticsKindForKey(key),
      r2Key: key
    });
  }

  const occurrence = await getOccurrence(env.DB, session.occurrence_id);
  if (!occurrence) return { ok: true };
  const settings = await getSettings(env.DB);

  const auditFor: Partial<Record<BotSessionState, { type: string; severity?: "info" | "warning" | "error" }>> = {
    joined: { type: "bot.joined" },
    recording: { type: "bot.recording" },
    waiting_room: { type: "bot.started" },
    post_processing_completed: { type: "recording.uploaded" },
    failed: { type: "bot.failed", severity: "error" },
    canceled: { type: "bot.canceled" }
  };
  const audit = auditFor[state];
  if (audit) {
    await createAuditLog(env.DB, {
      eventType: audit.type,
      severity: audit.severity ?? "info",
      resourceType: "bot_session",
      resourceId: session.id,
      message: payload.failureReason ?? undefined,
      metadata: { occurrenceId: occurrence.id, state, failureStage: payload.failureStage ?? null }
    });
  }

  const recordingReady = state === "post_processing_completed" || (state === "canceled" && Boolean(payload.recordingKey));
  if (recordingReady && payload.recordingKey) {
    const expiresAt = new Date(Date.now() + settings.retention.recordingDays * 86_400_000).toISOString();
    await upsertArtifact(env.DB, {
      ownerType: "bot_session",
      ownerId: session.id,
      kind: "recording",
      r2Key: payload.recordingKey,
      contentType: "audio/mpeg",
      expiresAt
    });
    for (const chunkKey of payload.recordingChunkKeys ?? []) {
      await upsertArtifact(env.DB, {
        ownerType: "bot_session",
        ownerId: session.id,
        kind: "recording_chunk",
        r2Key: chunkKey,
        contentType: "audio/mpeg",
        expiresAt
      });
    }
    if (!["canceled", "completed", "completed_no_eligible_recipients", "failed", "skipped"].includes(occurrence.status) || state === "canceled") {
      await updateOccurrenceStatus(env.DB, occurrence.id, "post_meeting", { latestBotSessionId: session.id });
    }
    await createJob(env.DB, {
      type: "transcribe",
      idempotencyKey: `transcribe:${occurrence.id}`,
      ownerType: "occurrence",
      ownerId: occurrence.id,
      nextRunAt: nowIso(),
      payload: { occurrenceId: occurrence.id }
    });
    await env.JOBS_QUEUE.send({ type: "sweep_due_jobs" });
    return { ok: true };
  }

  if (state === "failed") {
    await maybeRetryJoin(env, settings, occurrence, payload.failureStage ?? null, payload.failureReason ?? null, new Date());
    return { ok: true };
  }
  if (state === "canceled") {
    if (!["completed", "completed_no_eligible_recipients", "failed", "skipped"].includes(occurrence.status)) {
      await updateOccurrenceStatus(env.DB, occurrence.id, "canceled");
    }
    return { ok: true };
  }

  const mapped = mapBotStateToOccurrenceStatus(state);
  if (!["completed", "completed_no_eligible_recipients", "failed", "canceled", "skipped"].includes(occurrence.status)) {
    await updateOccurrenceStatus(env.DB, occurrence.id, mapped, { latestBotSessionId: session.id });
  }
  return { ok: true };
}

function diagnosticsKindForKey(key: string): "screenshot" | "html_snapshot" | "console_log" | "bot_log" | "diagnostics" {
  if (key.endsWith(".png")) return "screenshot";
  if (key.endsWith(".html")) return "html_snapshot";
  if (key.endsWith("console.log")) return "console_log";
  if (key.endsWith("bot.log")) return "bot_log";
  return "diagnostics";
}
