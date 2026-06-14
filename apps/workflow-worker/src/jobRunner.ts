import { completeJob, computeBackoffIso, createAuditLog, failJob, getOccurrence, leaseJob, updateOccurrenceStatus, type JobRow } from "@minutesbot/db";
import type { JobType } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";
import {
  handleCancelBot,
  handleExpandRecurrences,
  handleGenerateRecap,
  handleMonitorBot,
  handleRetentionCleanup,
  handleScheduleJoin,
  handleSendRecap,
  handleTranscribe,
  loadJobContext,
  TerminalJobError,
  type JobContext
} from "./jobHandlers";

const handlers: Record<JobType, (ctx: JobContext) => Promise<void>> = {
  schedule_join: handleScheduleJoin,
  monitor_bot: handleMonitorBot,
  cancel_bot: handleCancelBot,
  transcribe: handleTranscribe,
  generate_recap: handleGenerateRecap,
  send_recap: handleSendRecap,
  expand_recurrences: handleExpandRecurrences,
  retention_cleanup: handleRetentionCleanup
};

/** Long-running AI/IO jobs hold their lease longer than quick control jobs. */
const leaseSecondsByType: Partial<Record<JobType, number>> = {
  transcribe: 15 * 60,
  generate_recap: 15 * 60,
  send_recap: 10 * 60
};

export type RunJobOutcome = "completed" | "not_leasable" | "retry_scheduled" | "dead_letter" | "failed_terminal" | "lease_lost";

/**
 * Executes one job under a lease. Safe against duplicate queue deliveries
 * (lease is atomic), consumer crashes (lease expires and the sweeper
 * re-enqueues), and handler bugs (errors classify into retry/dead-letter).
 */
export async function runJob(env: WorkflowEnv, jobId: string): Promise<RunJobOutcome> {
  const leased = await leaseJob(env.DB, jobId, leaseSecondsByType[(await jobTypeOf(env, jobId)) ?? "schedule_join"] ?? 5 * 60);
  if (!leased) return "not_leasable";
  const { job, leaseId } = leased;
  const handler = handlers[job.type];
  if (!handler) {
    await failJob(env.DB, job.id, leaseId, { error: `Unknown job type ${job.type}`, retryable: false });
    return "failed_terminal";
  }
  try {
    const ctx = await loadJobContext(env, job);
    await handler(ctx);
    await completeJob(env.DB, job.id, leaseId);
    return "completed";
  } catch (error) {
    const terminal = error instanceof TerminalJobError;
    const messageText = error instanceof Error ? error.message.slice(0, 1500) : "Job failed";
    const outcome = await failJob(env.DB, job.id, leaseId, {
      error: messageText,
      retryable: !terminal,
      nextRunAt: computeBackoffIso(job.attempts)
    });
    if (outcome === "dead_letter" || outcome === "failed_terminal") {
      await recordTerminalJobFailure(env, job, messageText, outcome);
    }
    return outcome === "lease_lost" ? "lease_lost" : terminal ? "failed_terminal" : outcome;
  }
}

async function jobTypeOf(env: WorkflowEnv, jobId: string): Promise<JobType | null> {
  const row = await env.DB.prepare("SELECT type FROM jobs WHERE id = ?").bind(jobId).first<{ type: JobType }>();
  return row?.type ?? null;
}

/** Dead-lettered pipeline jobs surface on their occurrence so the admin sees them. */
async function recordTerminalJobFailure(env: WorkflowEnv, job: JobRow, error: string, outcome: string): Promise<void> {
  await createAuditLog(env.DB, {
    eventType: "job.dead_letter",
    severity: "error",
    resourceType: "job",
    resourceId: job.id,
    message: `${job.type} ${outcome}: ${error.slice(0, 300)}`,
    metadata: { jobType: job.type, ownerType: job.owner_type, ownerId: job.owner_id, attempts: job.attempts }
  });
  if (job.owner_type === "occurrence" && job.owner_id && ["transcribe", "generate_recap", "send_recap"].includes(job.type)) {
    const occurrence = await getOccurrence(env.DB, job.owner_id);
    if (occurrence && !["completed", "completed_no_eligible_recipients", "canceled"].includes(occurrence.status)) {
      await updateOccurrenceStatus(env.DB, occurrence.id, "failed", { lastError: `${job.type} exhausted retries: ${error.slice(0, 300)}` });
    }
  }
}
