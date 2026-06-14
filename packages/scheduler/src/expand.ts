import {
  cancelJobsForOwner,
  getOccurrenceByKey,
  listOccurrencesForEvent,
  markEventExpanded,
  pruneObsoleteOccurrences,
  upsertOccurrence,
  type CalendarEventRow,
  type OccurrenceRow
} from "@minutesbot/db";
import { expandRecurrence, occurrenceKeyFromUtc, type IcsDateTimeLike } from "@minutesbot/recurrence";
import type { AppSettings } from "@minutesbot/shared";
import { syncJoinJob } from "./joinJobs";

export type ExpansionResult = {
  upserted: number;
  pruned: number;
  jobsCreated: number;
  occurrences: OccurrenceRow[];
};

/**
 * Expands a calendar event into occurrence rows over the rolling window and
 * keeps their join jobs in sync. Idempotent: re-running on an unchanged
 * event is a no-op. Overridden occurrences are never touched by expansion.
 */
export async function expandEventOccurrences(
  db: D1Database,
  event: CalendarEventRow,
  settings: AppSettings,
  options?: { now?: Date }
): Promise<ExpansionResult> {
  const now = options?.now ?? new Date();
  if (event.status !== "active" || !event.start_time || !event.end_time) {
    return { upserted: 0, pruned: 0, jobsCreated: 0, occurrences: [] };
  }
  const windowStart = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + settings.scheduling.recurrenceExpansionDays * 24 * 60 * 60 * 1000).toISOString();

  const durationMs = Math.max(Date.parse(event.end_time) - Date.parse(event.start_time), 60_000);
  const seriesStart: IcsDateTimeLike = {
    utc: event.start_time,
    wallClock: event.start_wall_clock ?? undefined,
    timeZone: event.time_zone ?? undefined
  };
  const rdates = parseDateList(event.rdates);
  const exdates = parseDateList(event.exdates);

  const instances = expandRecurrence({
    seriesStart,
    durationMs,
    rrule: event.rrule ?? undefined,
    rdates: rdates.map((utc) => ({ utc })),
    exdates: exdates.map((utc) => ({ utc })),
    windowStart,
    windowEnd,
    maxOccurrences: 1000
  });

  const existing = await listOccurrencesForEvent(db, event.id);
  const overrideKeys = new Set(existing.filter((row) => row.is_override === 1).map((row) => row.occurrence_key));

  let upserted = 0;
  let jobsCreated = 0;
  const occurrences: OccurrenceRow[] = [];
  for (const instance of instances) {
    if (overrideKeys.has(instance.occurrenceKey)) continue;
    const result = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: instance.occurrenceKey,
      sequence: event.sequence,
      subject: event.subject,
      teamsJoinUrl: event.teams_join_url,
      startTime: instance.start,
      endTime: instance.end
    });
    if (!result.applied) continue;
    upserted += 1;
    occurrences.push(result.occurrence);
    const outcome = await syncJoinJob(db, result.occurrence, settings, { now, rescheduled: result.rescheduled });
    if (outcome === "created") jobsCreated += 1;
  }

  // Occurrences the rules no longer generate (RRULE changed, EXDATE added)
  // are canceled if still untouched and in the future.
  const validKeys = new Set([...instances.map((instance) => instance.occurrenceKey), ...overrideKeys]);
  const pruned = await pruneObsoleteOccurrences(db, event.id, validKeys, now.toISOString());
  for (const row of pruned) {
    await cancelJobsForOwner(db, "occurrence", row.id, ["schedule_join"]);
  }

  await markEventExpanded(db, event.id, windowEnd);
  return { upserted, pruned: pruned.length, jobsCreated, occurrences };
}

export function parseDateList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/** Adds occurrence starts to an event's EXDATE list (used for occurrence cancels). */
export function mergeExdates(existingJson: string | null, additions: string[]): string[] {
  const merged = new Set([...parseDateList(existingJson), ...additions]);
  return Array.from(merged).sort();
}

export async function findOccurrenceByRecurrenceId(
  db: D1Database,
  eventId: string,
  recurrenceUtc: string
): Promise<OccurrenceRow | null> {
  return getOccurrenceByKey(db, eventId, occurrenceKeyFromUtc(recurrenceUtc));
}
