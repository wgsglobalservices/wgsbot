import { Hono } from "hono";
import { createAuditLog, getJob, listJobs, requeueJob } from "@minutesbot/db";
import { AppError, type JobStatus, type JobType } from "@minutesbot/shared";
import type { Env } from "../env";

export const jobsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const jobs = await listJobs(c.env.DB, {
      status: c.req.query("status") as JobStatus | undefined,
      type: c.req.query("type") as JobType | undefined,
      ownerId: c.req.query("ownerId"),
      limit: Number(c.req.query("limit") ?? 100)
    });
    return c.json({ jobs });
  })
  .post("/:id/requeue", async (c) => {
    const job = await getJob(c.env.DB, c.req.param("id"));
    if (!job) throw new AppError("NOT_FOUND", "Job not found.", 404);
    if (!["dead_letter", "failed_terminal", "failed_retryable", "canceled"].includes(job.status)) {
      throw new AppError("NOT_REQUEUABLE", `Job in status ${job.status} cannot be requeued.`, 409);
    }
    const requeued = await requeueJob(c.env.DB, job.id);
    if (!requeued || requeued.status !== "pending") {
      throw new AppError("NOT_REQUEUABLE", `Job in status ${job.status} cannot be requeued.`, 409);
    }
    await c.env.JOBS_QUEUE.send({ type: "run_job", jobId: job.id });
    await createAuditLog(c.env.DB, {
      eventType: "admin.retry",
      resourceType: "job",
      resourceId: job.id,
      message: `Admin requeued ${job.type} job`
    });
    return c.json({ ok: true, job: requeued });
  });
