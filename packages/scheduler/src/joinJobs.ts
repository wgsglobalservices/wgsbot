import { cancelJobsForOwner, createJob, updateOccurrenceStatus, type OccurrenceRow } from "@minutesbot/db";
import type { AppSettings } from "@minutesbot/shared";

export type JoinJobOutcome = "created" | "exists" | "skipped_past" | "skipped_status";

/**
 * Ensures exactly one pending schedule_join job exists for an occurrence,
 * keyed by its scheduled join time. Reschedules cancel the previous job
 * (different key) and create a new one. Occurrences whose window has fully
 * passed are marked skipped instead.
 */
export async function syncJoinJob(
  db: D1Database,
  occurrence: OccurrenceRow,
  settings: AppSettings,
  options?: { now?: Date; rescheduled?: boolean }
): Promise<JoinJobOutcome> {
  const now = options?.now ?? new Date();
  if (occurrence.status !== "scheduled" && occurrence.status !== "join_queued") return "skipped_status";

  const endMs = Date.parse(occurrence.end_time);
  if (Number.isFinite(endMs) && endMs <= now.getTime()) {
    await cancelJobsForOwner(db, "occurrence", occurrence.id, ["schedule_join"]);
    await updateOccurrenceStatus(db, occurrence.id, "skipped", { lastError: "Occurrence ended before a join could be scheduled" });
    return "skipped_past";
  }

  const startMs = Date.parse(occurrence.start_time);
  const leadMs = settings.bot.joinLeadMinutes * 60_000;
  const joinAtMs = Math.max(now.getTime(), startMs - leadMs);
  const joinAtIso = new Date(joinAtMs).toISOString();

  if (options?.rescheduled) {
    await cancelJobsForOwner(db, "occurrence", occurrence.id, ["schedule_join"]);
  }
  const job = await createJob(db, {
    type: "schedule_join",
    idempotencyKey: `schedule_join:${occurrence.id}:${joinAtIso}`,
    ownerType: "occurrence",
    ownerId: occurrence.id,
    nextRunAt: joinAtIso,
    maxAttempts: settings.bot.maxJoinAttempts,
    payload: { occurrenceId: occurrence.id }
  });
  if (job && occurrence.scheduled_join_time !== joinAtIso) {
    await db
      .prepare("UPDATE meeting_occurrences SET scheduled_join_time = ?, updated_at = ? WHERE id = ?")
      .bind(joinAtIso, now.toISOString(), occurrence.id)
      .run();
  }
  return job ? "created" : "exists";
}
