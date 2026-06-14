import { createAuditLog, createJob, getOccurrence, getSettings, listStaleBotSessions, updateBotSessionState } from "@minutesbot/db";
import { nowIso } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";
import { maybeRetryJoin } from "./jobHandlers";
import { createRuntimeClient } from "./botRuntime";
import { sweepDueJobs } from "./queueConsumers";

/**
 * Cron entry point. The per-minute trigger drives the durable scheduler
 * (sweep due jobs + stale-session recovery); the daily trigger creates the
 * maintenance jobs.
 */
export async function handleScheduled(env: WorkflowEnv, cron: string): Promise<void> {
  if (cron === "0 3 * * *") {
    await createDailyMaintenanceJobs(env);
    return;
  }
  await sweepDueJobs(env);
  await recoverStaleSessions(env);
}

export async function createDailyMaintenanceJobs(env: WorkflowEnv): Promise<void> {
  const day = nowIso().slice(0, 10);
  const expand = await createJob(env.DB, {
    type: "expand_recurrences",
    idempotencyKey: `expand_recurrences:${day}`,
    ownerType: "system",
    ownerId: "maintenance",
    nextRunAt: nowIso()
  });
  const cleanup = await createJob(env.DB, {
    type: "retention_cleanup",
    idempotencyKey: `retention_cleanup:${day}`,
    ownerType: "system",
    ownerId: "maintenance",
    nextRunAt: nowIso()
  });
  for (const job of [expand, cleanup]) {
    if (job) await env.JOBS_QUEUE.send({ type: "run_job", jobId: job.id });
  }
}

/**
 * Sessions whose heartbeat went silent: verify against the runtime and fail
 * them over so an occurrence can never hang forever on a dead container.
 */
export async function recoverStaleSessions(env: WorkflowEnv): Promise<number> {
  const settings = await getSettings(env.DB);
  const cutoff = new Date(Date.now() - settings.scheduling.staleSessionMinutes * 60_000).toISOString();
  const stale = await listStaleBotSessions(env.DB, cutoff);
  let recovered = 0;
  const client = createRuntimeClient(env);
  for (const session of stale) {
    let runtimeAlive = false;
    try {
      if (session.runtime_bot_id) {
        const status = await client.getBot(session.runtime_bot_id);
        runtimeAlive = !["failed", "canceled", "post_processing_completed"].includes(status.state);
      }
    } catch {
      runtimeAlive = false;
    }
    if (runtimeAlive) continue;
    await updateBotSessionState(env.DB, session.id, {
      state: "failed",
      failureStage: "internal",
      failureReason: "Stale session: no heartbeat and runtime not alive"
    });
    await createAuditLog(env.DB, {
      eventType: "bot.stale_recovered",
      severity: "warning",
      resourceType: "bot_session",
      resourceId: session.id,
      message: "Stale bot session failed over by cron sweep"
    });
    const occurrence = await getOccurrence(env.DB, session.occurrence_id);
    if (occurrence) {
      const settingsNow = await getSettings(env.DB);
      await maybeRetryJoin(env, settingsNow, occurrence, "internal", "Stale session recovered", new Date());
    }
    recovered += 1;
  }
  return recovered;
}
