import {
  cancelCalendarEvent,
  cancelJobsForOwner,
  cancelOccurrences,
  createAuditLog,
  getCalendarEventByUid,
  replaceAttendees,
  upsertCalendarEvent,
  upsertOccurrence,
  type CalendarEventRow,
  type OccurrenceRow
} from "@minutesbot/db";
import type { ParsedMeetingInvite, ParsedVEvent } from "@minutesbot/invite-parser";
import { occurrenceKeyFromUtc } from "@minutesbot/recurrence";
import type { AppSettings } from "@minutesbot/shared";
import { computeAttendeeRows } from "./attendees";
import { expandEventOccurrences, mergeExdates } from "./expand";
import { syncJoinJob } from "./joinJobs";

export type IngestAction =
  | "event_created"
  | "event_updated"
  | "series_canceled"
  | "occurrences_canceled"
  | "occurrence_updated"
  | "ignored_stale"
  | "ignored_unknown_event";

export type IngestOutcome = {
  action: IngestAction;
  eventId: string | null;
  occurrencesUpserted: number;
  occurrencesCanceled: number;
  jobsCreated: number;
  /** Occurrence rows with a live bot whose meeting was canceled — the caller cancels their bots. */
  botsToCancel: OccurrenceRow[];
  warnings: string[];
};

/**
 * Applies a parsed invite to the calendar model: creates/updates the series,
 * expands occurrences over the rolling window, applies per-occurrence
 * overrides, handles series and single-occurrence cancellations, and keeps
 * join jobs in sync. Idempotent across duplicate and replayed invites.
 */
export async function ingestParsedInvite(
  db: D1Database,
  invite: ParsedMeetingInvite,
  settings: AppSettings,
  options?: { now?: Date; inboundMessageId?: string }
): Promise<IngestOutcome> {
  const now = options?.now ?? new Date();
  const warnings: string[] = [];
  const events = invite.events.length > 0 ? invite.events : [invite];
  const master = events.find((event) => !event.recurrenceId) ?? null;
  const overrides = events.filter((event) => event.recurrenceId !== undefined);

  if (invite.kind === "cancel") {
    return handleCancel(db, invite, master, overrides, settings, now, warnings);
  }
  return handleRequest(db, invite, master, overrides, settings, now, warnings, options?.inboundMessageId);
}

async function handleRequest(
  db: D1Database,
  invite: ParsedMeetingInvite,
  master: ParsedVEvent | null,
  overrides: ParsedVEvent[],
  settings: AppSettings,
  now: Date,
  warnings: string[],
  inboundMessageId?: string
): Promise<IngestOutcome> {
  let event: CalendarEventRow | null = null;
  let created = false;
  let occurrencesUpserted = 0;
  let jobsCreated = 0;

  if (master) {
    const result = await upsertCalendarEvent(db, {
      icsUid: master.calendarUid,
      sequence: master.sequence ?? 0,
      organizerEmail: master.organizer.email || null,
      organizerName: master.organizer.name ?? null,
      subject: master.subject || null,
      teamsJoinUrl: invite.teamsJoinUrl,
      startTime: master.startTime,
      endTime: master.endTime,
      timeZone: master.startDateTime?.timeZone ?? null,
      startWallClock: master.startDateTime?.wallClock ?? null,
      rrule: master.rrule ?? null,
      rdates: master.rdates ? master.rdates.map((date) => date.utc) : null,
      exdates: master.exdates ? master.exdates.map((date) => date.utc) : null,
      status: "active",
      lastInboundMessageId: inboundMessageId ?? null
    });
    event = result.event;
    created = result.created;
    if (!result.applied) {
      return {
        action: "ignored_stale",
        eventId: event.id,
        occurrencesUpserted: 0,
        occurrencesCanceled: 0,
        jobsCreated: 0,
        botsToCancel: [],
        warnings: [...warnings, `Stale SEQUENCE ${master.sequence ?? 0} ignored (stored ${event.sequence})`]
      };
    }
    await replaceAttendees(db, event.id, null, computeAttendeeRows(master, settings));
    const expansion = await expandEventOccurrences(db, event, settings, { now });
    occurrencesUpserted += expansion.upserted;
    jobsCreated += expansion.jobsCreated;
  } else {
    // Override-only payload (e.g. "this occurrence moved") — the series must
    // already be known.
    event = await getCalendarEventByUid(db, invite.calendarUid);
    if (!event) {
      warnings.push(`Occurrence update for unknown series UID ${invite.calendarUid}`);
      return {
        action: "ignored_unknown_event",
        eventId: null,
        occurrencesUpserted: 0,
        occurrencesCanceled: 0,
        jobsCreated: 0,
        botsToCancel: [],
        warnings
      };
    }
  }

  for (const override of overrides) {
    if (!override.recurrenceId) continue;
    if (override.recurrenceRange === "THISANDFUTURE") {
      // Splitting a series mid-stream is not supported; the next full series
      // update from the organizer's calendar will reconcile. Surface loudly.
      warnings.push("RANGE=THISANDFUTURE override applied to its own occurrence only");
    }
    const result = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: occurrenceKeyFromUtc(override.recurrenceId.utc),
      recurrenceId: override.recurrenceId.utc,
      sequence: override.sequence ?? 0,
      isOverride: true,
      subject: override.subject || null,
      teamsJoinUrl: invite.teamsJoinUrl,
      startTime: override.startTime,
      endTime: override.endTime
    });
    if (!result.applied) {
      warnings.push(`Override for ${override.recurrenceId.utc} not applied (stale or occurrence already running)`);
      continue;
    }
    occurrencesUpserted += 1;
    if (override.attendees.length > 0) {
      await replaceAttendees(db, event.id, result.occurrence.id, computeAttendeeRows(override, settings));
    }
    const outcome = await syncJoinJob(db, result.occurrence, settings, { now, rescheduled: result.rescheduled });
    if (outcome === "created") jobsCreated += 1;
  }

  await createAuditLog(db, {
    actorEmail: invite.organizer.email || undefined,
    eventType: created ? "event.created" : "event.updated",
    resourceType: "calendar_event",
    resourceId: event.id,
    message: invite.subject || undefined,
    metadata: { sequence: master?.sequence ?? null, overrides: overrides.length, occurrencesUpserted }
  });

  return {
    action: overrides.length > 0 && !master ? "occurrence_updated" : created ? "event_created" : "event_updated",
    eventId: event.id,
    occurrencesUpserted,
    occurrencesCanceled: 0,
    jobsCreated,
    botsToCancel: [],
    warnings
  };
}

async function handleCancel(
  db: D1Database,
  invite: ParsedMeetingInvite,
  master: ParsedVEvent | null,
  overrides: ParsedVEvent[],
  settings: AppSettings,
  now: Date,
  warnings: string[]
): Promise<IngestOutcome> {
  const event = await getCalendarEventByUid(db, invite.calendarUid);
  if (!event) {
    warnings.push(`Cancellation for unknown UID ${invite.calendarUid}`);
    return {
      action: "ignored_unknown_event",
      eventId: null,
      occurrencesUpserted: 0,
      occurrencesCanceled: 0,
      jobsCreated: 0,
      botsToCancel: [],
      warnings
    };
  }

  const canceledOccurrenceEvents = overrides.length > 0 ? overrides : master?.recurrenceId ? [master] : [];
  const isOccurrenceCancel = canceledOccurrenceEvents.length > 0 && canceledOccurrenceEvents.every((row) => row.recurrenceId);

  if (isOccurrenceCancel) {
    const canceledUtcs = canceledOccurrenceEvents.map((row) => row.recurrenceId!.utc);
    const keys = canceledUtcs.map((utc) => occurrenceKeyFromUtc(utc));
    const canceled = await cancelOccurrences(db, event.id, keys);
    // Record the cancellations as EXDATEs so re-expansion cannot resurrect
    // the occurrences.
    await upsertCalendarEvent(db, {
      icsUid: event.ics_uid,
      sequence: Math.max(event.sequence, ...canceledOccurrenceEvents.map((row) => row.sequence ?? 0)),
      exdates: mergeExdates(event.exdates, canceledUtcs)
    });
    const botsToCancel: OccurrenceRow[] = [];
    for (const occurrence of canceled) {
      await cancelJobsForOwner(db, "occurrence", occurrence.id);
      if (occurrence.latest_bot_session_id) botsToCancel.push(occurrence);
      await createAuditLog(db, {
        eventType: "occurrence.canceled",
        resourceType: "occurrence",
        resourceId: occurrence.id,
        message: `Occurrence ${occurrence.occurrence_key} canceled by organizer`
      });
    }
    return {
      action: "occurrences_canceled",
      eventId: event.id,
      occurrencesUpserted: 0,
      occurrencesCanceled: canceled.length,
      jobsCreated: 0,
      botsToCancel,
      warnings
    };
  }

  // Series cancellation.
  const sequence = master?.sequence ?? event.sequence;
  const applied = await cancelCalendarEvent(db, event.id, sequence);
  if (!applied) {
    warnings.push(`Stale series cancel (sequence ${sequence}) ignored`);
    return {
      action: "ignored_stale",
      eventId: event.id,
      occurrencesUpserted: 0,
      occurrencesCanceled: 0,
      jobsCreated: 0,
      botsToCancel: [],
      warnings
    };
  }
  const canceled = await cancelOccurrences(db, event.id);
  const botsToCancel: OccurrenceRow[] = [];
  for (const occurrence of canceled) {
    await cancelJobsForOwner(db, "occurrence", occurrence.id);
    if (occurrence.latest_bot_session_id) botsToCancel.push(occurrence);
  }
  await createAuditLog(db, {
    actorEmail: invite.organizer.email || undefined,
    eventType: "event.canceled",
    resourceType: "calendar_event",
    resourceId: event.id,
    message: event.subject ?? undefined,
    metadata: { occurrencesCanceled: canceled.length }
  });
  return {
    action: "series_canceled",
    eventId: event.id,
    occurrencesUpserted: 0,
    occurrencesCanceled: canceled.length,
    jobsCreated: 0,
    botsToCancel,
    warnings
  };
}
