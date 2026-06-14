import { createJob, listDueJobs } from "@minutesbot/db";
import { nowIso } from "@minutesbot/shared";
import type { QueueMessageBody, WorkflowEnv } from "./env";
import { runJob } from "./jobRunner";

type QueueMessage = {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

type QueueBatch = { messages: readonly QueueMessage[] };

/**
 * Single consumer for the jobs queue. Messages are delivery hints: the jobs
 * table is the source of truth, so any message can be acked safely — the
 * cron sweeper re-enqueues anything still due.
 */
export async function handleQueueBatch(batch: QueueBatch, env: WorkflowEnv): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleQueueMessage(message.body as QueueMessageBody, env);
      message.ack();
    } catch (error) {
      console.error("queue message failed", { error: error instanceof Error ? error.message : String(error) });
      message.retry({ delaySeconds: 30 });
    }
  }
}

async function handleQueueMessage(body: QueueMessageBody, env: WorkflowEnv): Promise<void> {
  if (!body || typeof body !== "object" || !("type" in body)) return;
  switch (body.type) {
    case "run_job":
      await runJob(env, body.jobId);
      return;
    case "sweep_due_jobs":
      await sweepDueJobs(env);
      return;
    case "enqueue_cancel_bot": {
      const job = await createJob(env.DB, {
        type: "cancel_bot",
        idempotencyKey: `cancel_bot:${body.occurrenceId}:${nowIso().slice(0, 16)}`,
        ownerType: "occurrence",
        ownerId: body.occurrenceId,
        nextRunAt: nowIso(),
        payload: { occurrenceId: body.occurrenceId, reason: body.reason ?? "calendar_cancel" }
      });
      if (job) await env.JOBS_QUEUE.send({ type: "run_job", jobId: job.id });
      return;
    }
    default:
      return;
  }
}

/** Enqueues run_job messages for everything due (also recovers expired leases). */
export async function sweepDueJobs(env: WorkflowEnv, limit = 50): Promise<number> {
  const due = await listDueJobs(env.DB, limit);
  for (const job of due) {
    await env.JOBS_QUEUE.send({ type: "run_job", jobId: job.id });
  }
  return due.length;
}
