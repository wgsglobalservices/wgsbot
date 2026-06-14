import {
  createAuditLog,
  createBotSession,
  createJob,
  ensureRecap,
  ensureTranscript,
  getActiveBotSession,
  getArtifact,
  getBotSession,
  getCalendarEvent,
  getOccurrence,
  getRecapForOccurrence,
  getSettings,
  getTranscriptForOccurrence,
  incrementOccurrenceJoinAttempts,
  listArtifactsForOwner,
  listArtifactsByKindBefore,
  listDeliveriesForRecap,
  listEffectiveAttendees,
  listEventsNeedingExpansion,
  markArtifactDeleted,
  setBotSessionRuntimeId,
  updateBotSessionState,
  updateOccurrenceStatus,
  updateRecap,
  updateTranscript,
  upsertArtifact,
  upsertEmailDelivery,
  deleteAuditLogsBefore,
  deleteCompletedJobsBefore,
  type JobRow,
  type OccurrenceRow
} from "@minutesbot/db";
import { renderRecapEmail } from "@minutesbot/email-renderer";
import { createEmailProvider, createPolicyEnforcedProvider, formatEmailAddress } from "@minutesbot/email-sender";
import { expandEventOccurrences } from "@minutesbot/scheduler";
import { generateRecap, recapDocumentSchema, RecapError } from "@minutesbot/summary-engine";
import { transcribeRecording, TranscriptionError, type AudioChunkSource } from "@minutesbot/transcription";
import {
  botWebhookUrl,
  daysAgoIso,
  isRetryableJoinFailure,
  nowIso,
  recapHtmlKey,
  recapJsonKey,
  recapTextKey,
  recordingChunkKey,
  recordingKey,
  sha256Hex,
  transcriptJsonKey,
  transcriptTextKey,
  type AppSettings,
  type ArtifactKind
} from "@minutesbot/shared";
import { createRuntimeClient, recordingUploadUrl } from "./botRuntime";
import type { WorkflowEnv } from "./env";

/** Thrown by handlers to signal a terminal (non-retryable) job failure. */
export class TerminalJobError extends Error {}

export type JobContext = {
  env: WorkflowEnv;
  job: JobRow;
  settings: AppSettings;
  now: Date;
};

function payloadOf<T>(job: JobRow): T {
  try {
    return JSON.parse(job.payload ?? "{}") as T;
  } catch {
    throw new TerminalJobError(`Job ${job.id} payload is not valid JSON`);
  }
}

async function loadOccurrence(env: WorkflowEnv, job: JobRow): Promise<OccurrenceRow> {
  const { occurrenceId } = payloadOf<{ occurrenceId?: string }>(job);
  const id = occurrenceId ?? job.owner_id;
  if (!id) throw new TerminalJobError(`Job ${job.id} has no occurrence reference`);
  const occurrence = await getOccurrence(env.DB, id);
  if (!occurrence) throw new TerminalJobError(`Occurrence ${id} not found`);
  return occurrence;
}

// ---------------------------------------------------------------------------
// schedule_join: create a bot session and ask the runtime to join.
// ---------------------------------------------------------------------------
export async function handleScheduleJoin(ctx: JobContext): Promise<void> {
  const { env, settings, now } = ctx;
  const occurrence = await loadOccurrence(env, ctx.job);
  if (occurrence.status !== "scheduled" && occurrence.status !== "join_queued") return;
  const event = await getCalendarEvent(env.DB, occurrence.event_id);
  if (!event || event.status !== "active") return;
  if (Date.parse(occurrence.end_time) <= now.getTime()) {
    await updateOccurrenceStatus(env.DB, occurrence.id, "skipped", { lastError: "Meeting window passed before the bot could join" });
    await createAuditLog(env.DB, {
      eventType: "occurrence.skipped",
      severity: "warning",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      message: "Join job ran after the meeting ended"
    });
    return;
  }
  const meetingUrl = occurrence.teams_join_url ?? event.teams_join_url;
  if (!meetingUrl) {
    await updateOccurrenceStatus(env.DB, occurrence.id, "failed", { lastError: "No Teams join URL on occurrence or event" });
    throw new TerminalJobError("No Teams join URL available");
  }
  if (!env.BOT_INTERNAL_TOKEN) {
    throw new TerminalJobError("BOT_INTERNAL_TOKEN is not configured; cannot talk to the bot runtime");
  }

  const attempt = occurrence.join_attempts + 1;
  const session = await createBotSession(env.DB, occurrence.id, attempt);
  if (!session) {
    // An active session already exists — duplicate delivery or admin retry
    // racing the scheduler. The unique index made this safe; nothing to do.
    return;
  }
  await incrementOccurrenceJoinAttempts(env.DB, occurrence.id);

  const maxDurationSeconds = Math.min(
    settings.bot.maxMeetingDurationMinutes * 60,
    Math.max(900, Math.ceil((Date.parse(occurrence.end_time) - now.getTime()) / 1000) + 30 * 60)
  );
  const client = createRuntimeClient(env);
  try {
    const created = await client.createBot({
      botSessionId: session.id,
      occurrenceId: occurrence.id,
      meetingUrl,
      displayName: settings.bot.displayName,
      joinTimeoutSeconds: settings.bot.maxWaitingRoomMinutes * 60,
      maxDurationSeconds,
      recording: { format: "mp3" },
      webhook: { url: botWebhookUrl(env), token: env.BOT_INTERNAL_TOKEN },
      upload: {
        url: recordingUploadUrl(env),
        token: env.BOT_INTERNAL_TOKEN,
        recordingKey: recordingKey(occurrence.id, session.id),
        chunkKeyPrefix: recordingChunkKey(occurrence.id, session.id, 0).replace(/chunk-000\.mp3$/, ""),
        chunkThresholdBytes: 20 * 1024 * 1024
      }
    });
    await setBotSessionRuntimeId(env.DB, session.id, created.runtimeBotId);
    await updateOccurrenceStatus(env.DB, occurrence.id, "join_queued", { latestBotSessionId: session.id });
    await createAuditLog(env.DB, {
      eventType: "bot.session_created",
      resourceType: "bot_session",
      resourceId: session.id,
      message: `Bot join attempt ${attempt} for ${occurrence.subject ?? occurrence.id}`,
      metadata: { occurrenceId: occurrence.id, runtimeBotId: created.runtimeBotId, attempt }
    });
    await createJob(env.DB, {
      type: "monitor_bot",
      idempotencyKey: `monitor_bot:${session.id}:1`,
      ownerType: "bot_session",
      ownerId: session.id,
      nextRunAt: new Date(now.getTime() + (settings.bot.maxWaitingRoomMinutes + 5) * 60_000).toISOString(),
      payload: { botSessionId: session.id, check: 1 }
    });
  } catch (error) {
    // The session row must not stay active or it would block retries.
    await updateBotSessionState(env.DB, session.id, {
      state: "failed",
      failureStage: "internal",
      failureReason: error instanceof Error ? error.message.slice(0, 500) : "Bot runtime request failed"
    });
    const retryable = isRetryableRuntimeError(error);
    if (!retryable) {
      await updateOccurrenceStatus(env.DB, occurrence.id, "failed", {
        lastError: error instanceof Error ? error.message.slice(0, 500) : "Bot runtime rejected the session"
      });
      throw new TerminalJobError(error instanceof Error ? error.message : "Bot runtime rejected the session");
    }
    throw error;
  }
}

function isRetryableRuntimeError(error: unknown): boolean {
  if (error && typeof error === "object" && "retryable" in error) return Boolean((error as { retryable: unknown }).retryable);
  return true;
}

// ---------------------------------------------------------------------------
// monitor_bot: stale/heartbeat safety net per session.
// ---------------------------------------------------------------------------
export async function handleMonitorBot(ctx: JobContext): Promise<void> {
  const { env, settings, now } = ctx;
  const { botSessionId, check } = payloadOf<{ botSessionId?: string; check?: number }>(ctx.job);
  if (!botSessionId) throw new TerminalJobError("monitor_bot job missing botSessionId");
  const session = await getBotSession(env.DB, botSessionId);
  if (!session || session.is_active === 0) return;

  const staleCutoff = now.getTime() - settings.scheduling.staleSessionMinutes * 60_000;
  const lastHeartbeat = session.last_heartbeat_at ? Date.parse(session.last_heartbeat_at) : 0;
  if (lastHeartbeat >= staleCutoff) {
    // Healthy: schedule the next check while the session lives.
    await createJob(env.DB, {
      type: "monitor_bot",
      idempotencyKey: `monitor_bot:${session.id}:${(check ?? 1) + 1}`,
      ownerType: "bot_session",
      ownerId: session.id,
      nextRunAt: new Date(now.getTime() + settings.scheduling.staleSessionMinutes * 60_000).toISOString(),
      payload: { botSessionId: session.id, check: (check ?? 1) + 1 }
    });
    return;
  }

  // Heartbeats stopped — ask the runtime directly before declaring it dead.
  const client = createRuntimeClient(env);
  let runtimeState: string | null = null;
  try {
    if (session.runtime_bot_id) {
      const status = await client.getBot(session.runtime_bot_id);
      runtimeState = status.state;
    }
  } catch {
    runtimeState = null;
  }
  if (runtimeState && !["failed", "canceled", "post_processing_completed"].includes(runtimeState)) {
    // Runtime is alive but webhooks are not arriving; trust the runtime and
    // keep monitoring.
    await createJob(env.DB, {
      type: "monitor_bot",
      idempotencyKey: `monitor_bot:${session.id}:${(check ?? 1) + 1}`,
      ownerType: "bot_session",
      ownerId: session.id,
      nextRunAt: new Date(now.getTime() + settings.scheduling.staleSessionMinutes * 60_000).toISOString(),
      payload: { botSessionId: session.id, check: (check ?? 1) + 1 }
    });
    return;
  }

  await updateBotSessionState(env.DB, session.id, {
    state: "failed",
    failureStage: "internal",
    failureReason: runtimeState ? `Runtime reported terminal state ${runtimeState} without a webhook` : "No heartbeat and runtime unreachable"
  });
  await createAuditLog(env.DB, {
    eventType: "bot.stale_recovered",
    severity: "warning",
    resourceType: "bot_session",
    resourceId: session.id,
    message: "Stale bot session recovered by monitor"
  });
  const occurrence = await getOccurrence(env.DB, session.occurrence_id);
  if (occurrence) await maybeRetryJoin(env, settings, occurrence, "internal", "Stale session recovered", now);
}

/**
 * After a failed session: retry the join if the failure class is retryable,
 * attempts remain, and the meeting is still running; otherwise mark the
 * occurrence failed.
 */
export async function maybeRetryJoin(
  env: WorkflowEnv,
  settings: AppSettings,
  occurrence: OccurrenceRow,
  failureStage: string | null,
  failureReason: string | null,
  now: Date
): Promise<void> {
  const fresh = await getOccurrence(env.DB, occurrence.id);
  if (!fresh) return;
  if (["canceled", "completed", "completed_no_eligible_recipients", "skipped", "failed"].includes(fresh.status)) return;
  const meetingStillOpen = Date.parse(fresh.end_time) > now.getTime();
  if (isRetryableJoinFailure(failureStage) && fresh.join_attempts < settings.bot.maxJoinAttempts && meetingStillOpen) {
    await updateOccurrenceStatus(env.DB, fresh.id, "scheduled", { lastError: failureReason });
    await createJob(env.DB, {
      type: "schedule_join",
      idempotencyKey: `schedule_join:${fresh.id}:retry${fresh.join_attempts + 1}`,
      ownerType: "occurrence",
      ownerId: fresh.id,
      nextRunAt: nowIso(),
      maxAttempts: 2,
      payload: { occurrenceId: fresh.id }
    });
    await env.JOBS_QUEUE.send({ type: "sweep_due_jobs" });
    return;
  }
  await updateOccurrenceStatus(env.DB, fresh.id, "failed", { lastError: failureReason ?? "Bot session failed" });
  await createAuditLog(env.DB, {
    eventType: "bot.failed",
    severity: "error",
    resourceType: "occurrence",
    resourceId: fresh.id,
    message: failureReason ?? "Bot session failed",
    metadata: { failureStage, joinAttempts: fresh.join_attempts }
  });
}

// ---------------------------------------------------------------------------
// cancel_bot: stop the active runtime session for an occurrence.
// ---------------------------------------------------------------------------
export async function handleCancelBot(ctx: JobContext): Promise<void> {
  const { env } = ctx;
  const occurrence = await loadOccurrence(env, ctx.job);
  const session = await getActiveBotSession(env.DB, occurrence.id);
  if (!session) return;
  const client = createRuntimeClient(env);
  if (session.runtime_bot_id) {
    try {
      await client.cancelBot(session.runtime_bot_id);
    } catch (error) {
      if (isRetryableRuntimeError(error)) throw error;
    }
  }
  await createAuditLog(env.DB, {
    eventType: "bot.canceled",
    resourceType: "bot_session",
    resourceId: session.id,
    message: "Cancellation requested",
    metadata: { occurrenceId: occurrence.id }
  });
}

// ---------------------------------------------------------------------------
// transcribe: recording artifacts -> Whisper -> transcript artifacts.
// ---------------------------------------------------------------------------
export async function handleTranscribe(ctx: JobContext): Promise<void> {
  const { env, settings } = ctx;
  const occurrence = await loadOccurrence(env, ctx.job);
  const transcript = await ensureTranscript(env.DB, occurrence.id);
  if (transcript.status === "completed") {
    await ensureRecapJob(env, occurrence.id);
    return;
  }

  const apiKey = env.TRANSCRIPTION_API_KEY ?? env.AI_API_KEY;
  if (!apiKey) {
    await updateTranscript(env.DB, transcript.id, { status: "failed_terminal", lastError: "No transcription API key configured" });
    throw new TerminalJobError("No transcription API key configured (set the AI_API_KEY secret)");
  }

  const sessionId = occurrence.latest_bot_session_id;
  if (!sessionId) {
    await updateTranscript(env.DB, transcript.id, { status: "failed_terminal", lastError: "Occurrence has no bot session/recording" });
    throw new TerminalJobError("No bot session recorded for occurrence");
  }
  const sessionArtifacts = await listArtifactsForOwner(env.DB, "bot_session", sessionId);
  const chunkArtifacts = sessionArtifacts
    .filter((artifact) => artifact.kind === "recording_chunk" && !artifact.deleted_at)
    .sort((a, b) => a.r2_key.localeCompare(b.r2_key));
  const recordingArtifact = sessionArtifacts.find((artifact) => artifact.kind === "recording" && !artifact.deleted_at);
  const sources = chunkArtifacts.length > 0 ? chunkArtifacts : recordingArtifact ? [recordingArtifact] : [];
  if (sources.length === 0) {
    await updateTranscript(env.DB, transcript.id, { status: "failed_terminal", lastError: "No recording artifact found" });
    throw new TerminalJobError("No recording artifact found for occurrence");
  }

  await updateOccurrenceStatus(env.DB, occurrence.id, "transcribing");
  await updateTranscript(env.DB, transcript.id, { status: "running", incrementAttempts: true });
  await createAuditLog(env.DB, { eventType: "transcription.started", resourceType: "occurrence", resourceId: occurrence.id });

  // Chunk offsets: ffmpeg splits at ~10-minute boundaries; exact segment
  // durations come back from the provider, so offsets only need ordering.
  const chunks: AudioChunkSource[] = sources.map((artifact, index) => ({
    key: artifact.r2_key,
    offsetSeconds: index * 600,
    load: async () => {
      const object = await env.ARTIFACTS.get(artifact.r2_key);
      if (!object) throw new TranscriptionError(`Recording object missing from R2: ${artifact.r2_key}`, { retryable: false });
      return { data: await object.arrayBuffer(), contentType: artifact.content_type ?? "audio/mpeg" };
    }
  }));

  try {
    const result = await transcribeRecording({
      chunks,
      config: {
        provider: settings.transcription.provider,
        baseUrl: settings.transcription.baseUrl || undefined,
        model: settings.transcription.model,
        apiKey,
        language: settings.transcription.language || undefined
      }
    });
    const jsonKey = transcriptJsonKey(occurrence.id);
    const textKey = transcriptTextKey(occurrence.id);
    const jsonBody = JSON.stringify(
      { language: result.language, durationSeconds: result.durationSeconds, provider: result.provider, model: result.model, segments: result.segments },
      null,
      2
    );
    await env.ARTIFACTS.put(jsonKey, jsonBody, { httpMetadata: { contentType: "application/json" } });
    await env.ARTIFACTS.put(textKey, result.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const expiresAt = new Date(Date.now() + settings.retention.transcriptDays * 86_400_000).toISOString();
    const jsonArtifact = await upsertArtifact(env.DB, {
      ownerType: "occurrence",
      ownerId: occurrence.id,
      kind: "transcript_json",
      r2Key: jsonKey,
      contentType: "application/json",
      sizeBytes: jsonBody.length,
      sha256: await sha256Hex(jsonBody),
      expiresAt
    });
    const textArtifact = await upsertArtifact(env.DB, {
      ownerType: "occurrence",
      ownerId: occurrence.id,
      kind: "transcript_text",
      r2Key: textKey,
      contentType: "text/plain; charset=utf-8",
      sizeBytes: result.text.length,
      sha256: await sha256Hex(result.text),
      expiresAt
    });
    await updateTranscript(env.DB, transcript.id, {
      status: "completed",
      provider: result.provider,
      model: result.model,
      language: result.language ?? null,
      durationSeconds: result.durationSeconds ?? null,
      jsonArtifactId: jsonArtifact.id,
      textArtifactId: textArtifact.id,
      lastError: null
    });
    await createAuditLog(env.DB, {
      eventType: "transcription.completed",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      metadata: { chunkCount: result.chunkCount, durationSeconds: result.durationSeconds }
    });
    await ensureRecapJob(env, occurrence.id);
    await env.JOBS_QUEUE.send({ type: "sweep_due_jobs" });
  } catch (error) {
    const retryable = error instanceof TranscriptionError ? error.retryable : true;
    const messageText = error instanceof Error ? error.message.slice(0, 1000) : "Transcription failed";
    await updateTranscript(env.DB, transcript.id, { status: retryable ? "failed_retryable" : "failed_terminal", lastError: messageText });
    await createAuditLog(env.DB, {
      eventType: "transcription.failed",
      severity: "error",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      message: messageText
    });
    if (!retryable) {
      await updateOccurrenceStatus(env.DB, occurrence.id, "failed", { lastError: messageText });
      throw new TerminalJobError(messageText);
    }
    throw error;
  }
}

async function ensureRecapJob(env: WorkflowEnv, occurrenceId: string): Promise<void> {
  await createJob(env.DB, {
    type: "generate_recap",
    idempotencyKey: `generate_recap:${occurrenceId}`,
    ownerType: "occurrence",
    ownerId: occurrenceId,
    nextRunAt: nowIso(),
    payload: { occurrenceId }
  });
}

// ---------------------------------------------------------------------------
// generate_recap: transcript text -> GPT recap -> recap artifacts.
// ---------------------------------------------------------------------------
export async function handleGenerateRecap(ctx: JobContext): Promise<void> {
  const { env, settings } = ctx;
  const occurrence = await loadOccurrence(env, ctx.job);
  const recap = await ensureRecap(env.DB, occurrence.id);
  if (recap.status === "completed") {
    await ensureSendJob(env, occurrence.id);
    return;
  }
  if (!env.AI_API_KEY) {
    await updateRecap(env.DB, recap.id, { status: "failed_terminal", lastError: "No AI API key configured" });
    throw new TerminalJobError("No AI API key configured (set the AI_API_KEY secret)");
  }
  const transcript = await getTranscriptForOccurrence(env.DB, occurrence.id);
  if (!transcript || transcript.status !== "completed" || !transcript.text_artifact_id) {
    throw new TerminalJobError("Transcript is not completed; cannot generate recap");
  }
  const textArtifact = await getArtifact(env.DB, transcript.text_artifact_id);
  const object = textArtifact ? await env.ARTIFACTS.get(textArtifact.r2_key) : null;
  if (!object) {
    await updateRecap(env.DB, recap.id, { status: "failed_terminal", lastError: "Transcript text artifact missing from R2" });
    throw new TerminalJobError("Transcript text artifact missing from R2");
  }
  const transcriptText = await object.text();
  const event = await getCalendarEvent(env.DB, occurrence.event_id);
  const attendees = event ? await listEffectiveAttendees(env.DB, event.id, occurrence.id) : [];

  await updateOccurrenceStatus(env.DB, occurrence.id, "summarizing");
  await updateRecap(env.DB, recap.id, { status: "running", incrementAttempts: true });
  await createAuditLog(env.DB, { eventType: "recap.started", resourceType: "occurrence", resourceId: occurrence.id });

  try {
    const result = await generateRecap({
      transcriptText,
      meeting: {
        subject: occurrence.subject ?? event?.subject ?? undefined,
        startTime: occurrence.start_time,
        durationMinutes: Math.round((Date.parse(occurrence.end_time) - Date.parse(occurrence.start_time)) / 60_000),
        attendeeNames: attendees.map((attendee) => attendee.name ?? attendee.email)
      },
      config: {
        baseUrl: settings.recap.baseUrl || undefined,
        model: settings.recap.model,
        apiKey: env.AI_API_KEY
      }
    });

    const rendered = renderRecapEmail({
      subject: occurrence.subject ?? event?.subject ?? "Meeting",
      startTime: occurrence.start_time,
      timeZone: settings.timeZone,
      recap: result.recap,
      subjectPrefix: settings.recap.subjectPrefix,
      introText: settings.recap.introText || undefined,
      adminUrl: env.APP_BASE_URL ? `${env.APP_BASE_URL.replace(/\/+$/, "")}/occurrences/${occurrence.id}` : undefined
    });

    const expiresAt = new Date(Date.now() + settings.retention.summaryDays * 86_400_000).toISOString();
    const jsonKey = recapJsonKey(occurrence.id);
    const htmlKey = recapHtmlKey(occurrence.id);
    const textKey = recapTextKey(occurrence.id);
    const jsonBody = JSON.stringify({ recap: result.recap, model: result.model, repaired: result.repaired, chunked: result.chunked }, null, 2);
    await env.ARTIFACTS.put(jsonKey, jsonBody, { httpMetadata: { contentType: "application/json" } });
    await env.ARTIFACTS.put(htmlKey, rendered.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await env.ARTIFACTS.put(textKey, rendered.text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    const jsonArtifact = await upsertArtifact(env.DB, {
      ownerType: "occurrence",
      ownerId: occurrence.id,
      kind: "summary_json",
      r2Key: jsonKey,
      contentType: "application/json",
      sizeBytes: jsonBody.length,
      sha256: await sha256Hex(jsonBody),
      expiresAt
    });
    const htmlArtifact = await upsertArtifact(env.DB, {
      ownerType: "occurrence",
      ownerId: occurrence.id,
      kind: "summary_html",
      r2Key: htmlKey,
      contentType: "text/html; charset=utf-8",
      sizeBytes: rendered.html.length,
      sha256: await sha256Hex(rendered.html),
      expiresAt
    });
    const textArtifactRow = await upsertArtifact(env.DB, {
      ownerType: "occurrence",
      ownerId: occurrence.id,
      kind: "summary_text",
      r2Key: textKey,
      contentType: "text/plain; charset=utf-8",
      sizeBytes: rendered.text.length,
      sha256: await sha256Hex(rendered.text),
      expiresAt
    });
    await updateRecap(env.DB, recap.id, {
      status: "completed",
      provider: result.provider,
      model: result.model,
      jsonArtifactId: jsonArtifact.id,
      htmlArtifactId: htmlArtifact.id,
      textArtifactId: textArtifactRow.id,
      lastError: null
    });
    await createAuditLog(env.DB, {
      eventType: "recap.completed",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      metadata: { model: result.model, repaired: result.repaired, chunked: result.chunked }
    });
    await ensureSendJob(env, occurrence.id);
    await env.JOBS_QUEUE.send({ type: "sweep_due_jobs" });
  } catch (error) {
    const retryable = error instanceof RecapError ? error.retryable : true;
    const messageText = error instanceof Error ? error.message.slice(0, 1000) : "Recap generation failed";
    const diagnostics = error instanceof RecapError ? error.diagnostics : undefined;
    await updateRecap(env.DB, recap.id, {
      status: retryable ? "failed_retryable" : "failed_terminal",
      lastError: diagnostics ? `${messageText}\n${diagnostics.slice(0, 800)}` : messageText
    });
    await createAuditLog(env.DB, {
      eventType: "recap.failed",
      severity: "error",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      message: messageText
    });
    if (!retryable) {
      await updateOccurrenceStatus(env.DB, occurrence.id, "failed", { lastError: messageText });
      throw new TerminalJobError(messageText);
    }
    throw error;
  }
}

async function ensureSendJob(env: WorkflowEnv, occurrenceId: string): Promise<void> {
  await createJob(env.DB, {
    type: "send_recap",
    idempotencyKey: `send_recap:${occurrenceId}`,
    ownerType: "occurrence",
    ownerId: occurrenceId,
    nextRunAt: nowIso(),
    payload: { occurrenceId }
  });
}

// ---------------------------------------------------------------------------
// send_recap: deliver to eligible recipients only.
// ---------------------------------------------------------------------------
export async function handleSendRecap(ctx: JobContext): Promise<void> {
  const { env, settings } = ctx;
  const occurrence = await loadOccurrence(env, ctx.job);
  const recap = await getRecapForOccurrence(env.DB, occurrence.id);
  if (!recap || recap.status !== "completed" || !recap.json_artifact_id) {
    throw new TerminalJobError("Recap is not completed; cannot send");
  }
  const event = await getCalendarEvent(env.DB, occurrence.event_id);
  if (!event) throw new TerminalJobError("Calendar event missing for occurrence");

  const attendees = await listEffectiveAttendees(env.DB, event.id, occurrence.id);
  const eligible = attendees.filter((attendee) => attendee.recipient_eligible === 1);
  const excluded = attendees.filter((attendee) => attendee.recipient_eligible !== 1).map((attendee) => attendee.email);

  if (eligible.length === 0) {
    await updateOccurrenceStatus(env.DB, occurrence.id, "completed_no_eligible_recipients");
    await createAuditLog(env.DB, {
      eventType: "email.skipped",
      severity: "warning",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      message: "Recap generated but no recipients are eligible under the domain policy",
      metadata: { excludedCount: excluded.length }
    });
    return;
  }

  const jsonArtifact = await getArtifact(env.DB, recap.json_artifact_id);
  const object = jsonArtifact ? await env.ARTIFACTS.get(jsonArtifact.r2_key) : null;
  if (!object) throw new TerminalJobError("Recap JSON artifact missing from R2");
  const parsed = recapDocumentSchema.safeParse((JSON.parse(await object.text()) as { recap: unknown }).recap);
  if (!parsed.success) throw new TerminalJobError("Stored recap JSON failed validation");

  const rendered = renderRecapEmail({
    subject: occurrence.subject ?? event.subject ?? "Meeting",
    startTime: occurrence.start_time,
    timeZone: settings.timeZone,
    recap: parsed.data,
    subjectPrefix: settings.recap.subjectPrefix,
    introText: settings.recap.introText || undefined,
    excludedRecipients: excluded,
    adminUrl: env.APP_BASE_URL ? `${env.APP_BASE_URL.replace(/\/+$/, "")}/occurrences/${occurrence.id}` : undefined
  });

  // Defense in depth: even if attendee rows were tampered with, the policy
  // wrapper refuses recipients outside the allowed domains.
  const provider = createPolicyEnforcedProvider(
    createEmailProvider({ provider: settings.email.provider, sendEmailBinding: env.SEND_EMAIL }),
    { allowedDomains: settings.allowedDomains, allowSubdomains: settings.policy.allowSubdomains }
  );

  await updateOccurrenceStatus(env.DB, occurrence.id, "sending_recap");
  const previous = await listDeliveriesForRecap(env.DB, recap.id);
  const alreadySent = new Set(previous.filter((row) => row.status === "sent").map((row) => row.recipient_email));

  let sent = 0;
  let failed = 0;
  for (const recipient of eligible) {
    if (alreadySent.has(recipient.email)) {
      sent += 1;
      continue;
    }
    const result = await provider.send({
      from: formatEmailAddress(settings.email.senderName, settings.email.senderEmail),
      to: recipient.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html
    });
    await upsertEmailDelivery(env.DB, {
      recapId: recap.id,
      occurrenceId: occurrence.id,
      recipientEmail: recipient.email,
      recipientDomain: recipient.domain ?? "",
      status: result.status === "sent" ? "sent" : "failed",
      providerMessageId: result.providerMessageId ?? null,
      error: result.failureReason ?? null
    });
    await createAuditLog(env.DB, {
      eventType: result.status === "sent" ? "email.delivered" : "email.failed",
      severity: result.status === "sent" ? "info" : "error",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      message: result.status === "sent" ? `Recap delivered to ${recipient.email}` : `Delivery to ${recipient.email} failed: ${result.failureReason}`
    });
    if (result.status === "sent") sent += 1;
    else failed += 1;
  }

  if (failed > 0) {
    throw new Error(`${failed} of ${eligible.length} recap deliveries failed; will retry unsent recipients`);
  }
  await updateOccurrenceStatus(env.DB, occurrence.id, "completed");
  await createAuditLog(env.DB, {
    eventType: "occurrence.completed",
    resourceType: "occurrence",
    resourceId: occurrence.id,
    metadata: { delivered: sent, excluded: excluded.length }
  });
}

// ---------------------------------------------------------------------------
// expand_recurrences: roll the occurrence window forward (daily maintenance).
// ---------------------------------------------------------------------------
export async function handleExpandRecurrences(ctx: JobContext): Promise<void> {
  const { env, settings, now } = ctx;
  const horizon = new Date(now.getTime() + (settings.scheduling.recurrenceExpansionDays - 1) * 86_400_000).toISOString();
  const events = await listEventsNeedingExpansion(env.DB, horizon);
  let upserted = 0;
  for (const event of events) {
    const result = await expandEventOccurrences(env.DB, event, settings, { now });
    upserted += result.upserted;
  }
  await createAuditLog(env.DB, {
    eventType: "maintenance.expanded",
    resourceType: "system",
    message: `Recurrence maintenance expanded ${events.length} events`,
    metadata: { events: events.length, occurrencesUpserted: upserted }
  });
}

// ---------------------------------------------------------------------------
// retention_cleanup: delete expired artifacts and old bookkeeping rows.
// ---------------------------------------------------------------------------
export async function handleRetentionCleanup(ctx: JobContext): Promise<void> {
  const { env, settings } = ctx;
  const retentionByKind: Array<{ kinds: ArtifactKind[]; days: number }> = [
    { kinds: ["raw_invite"], days: settings.retention.rawInviteDays },
    { kinds: ["recording", "recording_chunk"], days: settings.retention.recordingDays },
    { kinds: ["transcript_json", "transcript_text"], days: settings.retention.transcriptDays },
    { kinds: ["summary_json", "summary_html", "summary_text"], days: settings.retention.summaryDays },
    {
      kinds: ["screenshot", "html_snapshot", "console_log", "bot_log", "diagnostics", "bot_event_payload"],
      days: settings.retention.diagnosticsDays
    }
  ];
  let deleted = 0;
  for (const policy of retentionByKind) {
    const expired = await listArtifactsByKindBefore(env.DB, policy.kinds, daysAgoIso(policy.days));
    for (const artifact of expired) {
      await env.ARTIFACTS.delete(artifact.r2_key);
      await markArtifactDeleted(env.DB, artifact.id);
      deleted += 1;
    }
  }
  const auditDeleted = await deleteAuditLogsBefore(env.DB, daysAgoIso(settings.retention.auditLogDays));
  const jobsDeleted = await deleteCompletedJobsBefore(env.DB, daysAgoIso(7));
  await createAuditLog(env.DB, {
    eventType: "cleanup.completed",
    resourceType: "system",
    message: `Retention cleanup removed ${deleted} artifacts`,
    metadata: { artifactsDeleted: deleted, auditLogsDeleted: auditDeleted, jobsDeleted }
  });
}

export async function loadJobContext(env: WorkflowEnv, job: JobRow): Promise<JobContext> {
  const settings = await getSettings(env.DB);
  return { env, job, settings, now: new Date() };
}
