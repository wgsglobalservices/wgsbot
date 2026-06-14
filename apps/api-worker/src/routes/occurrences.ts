import { Hono } from "hono";
import {
  createAuditLog,
  createJob,
  getCalendarEvent,
  getJobByIdempotencyKey,
  getOccurrence,
  getRecapForOccurrence,
  getTranscriptForOccurrence,
  listArtifactsForOwner,
  listBotEvents,
  listBotSessionsForOccurrence,
  listDeliveriesForOccurrence,
  listEffectiveAttendees,
  listAuditLogs,
  listJobs,
  listOccurrences,
  requeueJob,
  updateOccurrenceStatus,
  updateRecap,
  updateTranscript,
  type JobRow
} from "@minutesbot/db";
import { AppError, nowIso, type JobType } from "@minutesbot/shared";
import type { Env } from "../env";

export const occurrencesRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const occurrences = await listOccurrences(c.env.DB, {
      status: c.req.query("status") as never,
      from: c.req.query("from"),
      to: c.req.query("to"),
      limit: Number(c.req.query("limit") ?? 200)
    });
    return c.json({ occurrences });
  })
  .get("/:id", async (c) => {
    const occurrence = await getOccurrence(c.env.DB, c.req.param("id"));
    if (!occurrence) throw new AppError("NOT_FOUND", "Occurrence not found.", 404);
    const event = await getCalendarEvent(c.env.DB, occurrence.event_id);
    const [sessions, attendees, transcript, recap, deliveries, artifacts, jobs, auditLogs] = await Promise.all([
      listBotSessionsForOccurrence(c.env.DB, occurrence.id),
      event ? listEffectiveAttendees(c.env.DB, event.id, occurrence.id) : Promise.resolve([]),
      getTranscriptForOccurrence(c.env.DB, occurrence.id),
      getRecapForOccurrence(c.env.DB, occurrence.id),
      listDeliveriesForOccurrence(c.env.DB, occurrence.id),
      listArtifactsForOwner(c.env.DB, "occurrence", occurrence.id),
      listJobs(c.env.DB, { ownerId: occurrence.id }),
      listAuditLogs(c.env.DB, { resourceId: c.req.param("id"), limit: 100 })
    ]);
    const sessionEvents = sessions.length > 0 ? await listBotEvents(c.env.DB, sessions[0].id, 100) : [];
    const sessionArtifacts = (
      await Promise.all(sessions.map((session) => listArtifactsForOwner(c.env.DB, "bot_session", session.id)))
    ).flat();
    return c.json({
      occurrence,
      event,
      botSessions: sessions,
      latestSessionEvents: sessionEvents,
      attendees,
      transcript,
      recap,
      deliveries,
      artifacts: [...artifacts, ...sessionArtifacts],
      jobs,
      auditLogs
    });
  })
  .post("/:id/retry-join", async (c) => {
    const occurrence = await requireOccurrence(c.env, c.req.param("id"));
    if (Date.parse(occurrence.end_time) <= Date.now()) {
      throw new AppError("MEETING_OVER", "The meeting window has passed; a bot can no longer join.", 409);
    }
    if (["in_meeting", "join_queued"].includes(occurrence.status)) {
      throw new AppError("ALREADY_ACTIVE", "A bot session is already active for this occurrence.", 409);
    }
    await updateOccurrenceStatus(c.env.DB, occurrence.id, "scheduled", { lastError: null });
    const job = await createJob(c.env.DB, {
      type: "schedule_join",
      idempotencyKey: `schedule_join:${occurrence.id}:admin:${nowIso()}`,
      ownerType: "occurrence",
      ownerId: occurrence.id,
      nextRunAt: nowIso(),
      maxAttempts: 2,
      payload: { occurrenceId: occurrence.id }
    });
    await dispatchAndAudit(c.env, occurrence.id, job, "retry-join");
    return c.json({ ok: true, jobId: job?.id ?? null });
  })
  .post("/:id/retry-transcription", async (c) => {
    const occurrence = await requireOccurrence(c.env, c.req.param("id"));
    const transcript = await getTranscriptForOccurrence(c.env.DB, occurrence.id);
    if (transcript && ["failed_terminal", "failed_retryable"].includes(transcript.status)) {
      await updateTranscript(c.env.DB, transcript.id, { status: "pending", lastError: null });
    }
    const job = await retryPipelineJob(c.env, "transcribe", occurrence.id);
    await dispatchAndAudit(c.env, occurrence.id, job, "retry-transcription");
    return c.json({ ok: true, jobId: job?.id ?? null });
  })
  .post("/:id/retry-recap", async (c) => {
    const occurrence = await requireOccurrence(c.env, c.req.param("id"));
    const recap = await getRecapForOccurrence(c.env.DB, occurrence.id);
    if (recap && ["failed_terminal", "failed_retryable"].includes(recap.status)) {
      await updateRecap(c.env.DB, recap.id, { status: "pending", lastError: null });
    }
    const job = await retryPipelineJob(c.env, "generate_recap", occurrence.id);
    await dispatchAndAudit(c.env, occurrence.id, job, "retry-recap");
    return c.json({ ok: true, jobId: job?.id ?? null });
  })
  .post("/:id/retry-delivery", async (c) => {
    const occurrence = await requireOccurrence(c.env, c.req.param("id"));
    const recap = await getRecapForOccurrence(c.env.DB, occurrence.id);
    if (!recap || recap.status !== "completed") {
      throw new AppError("RECAP_NOT_READY", "Generate a recap before retrying delivery.", 409);
    }
    const job = await retryPipelineJob(c.env, "send_recap", occurrence.id);
    await dispatchAndAudit(c.env, occurrence.id, job, "retry-delivery");
    return c.json({ ok: true, jobId: job?.id ?? null });
  })
  .post("/:id/cancel-bot", async (c) => {
    const occurrence = await requireOccurrence(c.env, c.req.param("id"));
    await c.env.JOBS_QUEUE.send({ type: "enqueue_cancel_bot", occurrenceId: occurrence.id, reason: "admin_cancel" });
    await createAuditLog(c.env.DB, {
      eventType: "admin.cancel",
      resourceType: "occurrence",
      resourceId: occurrence.id,
      message: "Admin requested bot cancellation"
    });
    return c.json({ ok: true });
  });

async function requireOccurrence(env: Env, id: string) {
  const occurrence = await getOccurrence(env.DB, id);
  if (!occurrence) throw new AppError("NOT_FOUND", "Occurrence not found.", 404);
  return occurrence;
}

/**
 * Pipeline jobs are keyed `type:occurrenceId`. A retry either requeues the
 * exhausted job or creates it if it never existed.
 */
async function retryPipelineJob(env: Env, type: JobType, occurrenceId: string): Promise<JobRow | null> {
  const existing = await getJobByIdempotencyKey(env.DB, `${type}:${occurrenceId}`);
  if (existing) {
    if (existing.status === "completed" && type !== "send_recap") {
      // Completed pipeline steps are idempotent: re-running re-checks state.
      return requeueCompleted(env, existing);
    }
    return requeueJob(env.DB, existing.id) ?? existing;
  }
  return createJob(env.DB, {
    type,
    idempotencyKey: `${type}:${occurrenceId}`,
    ownerType: "occurrence",
    ownerId: occurrenceId,
    nextRunAt: nowIso(),
    payload: { occurrenceId }
  });
}

async function requeueCompleted(env: Env, job: JobRow): Promise<JobRow | null> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'pending', attempts = 0, lease_id = NULL, lease_expires_at = NULL, next_run_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(nowIso(), nowIso(), job.id)
    .run();
  return { ...job, status: "pending", attempts: 0 };
}

async function dispatchAndAudit(env: Env, occurrenceId: string, job: JobRow | null, action: string): Promise<void> {
  if (job) await env.JOBS_QUEUE.send({ type: "run_job", jobId: job.id });
  await createAuditLog(env.DB, {
    eventType: "admin.retry",
    resourceType: "occurrence",
    resourceId: occurrenceId,
    message: `Admin action: ${action}`,
    metadata: { jobId: job?.id ?? null }
  });
}
