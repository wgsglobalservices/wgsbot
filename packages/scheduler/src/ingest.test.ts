import { describe, expect, it } from "vitest";
import { defaultSettings, type AppSettings } from "@minutesbot/shared";
import {
  getCalendarEventByUid,
  getOccurrence,
  listEventAttendees,
  listJobs,
  listOccurrencesForEvent,
  updateOccurrenceStatus
} from "@minutesbot/db";
import type { ParsedMeetingInvite, ParsedVEvent } from "@minutesbot/invite-parser";
import { createMigratedD1 } from "../../../tests/d1Sqlite";
import { ingestParsedInvite } from "./ingest";
import { expandEventOccurrences } from "./expand";

const settings: AppSettings = {
  ...defaultSettings,
  recorderEmail: "notetaker@acme.com",
  allowedDomains: ["acme.com"],
  email: { ...defaultSettings.email, senderEmail: "notetaker@acme.com" }
};

const now = new Date("2026-06-10T00:00:00.000Z");

function makeInvite(overrides: Partial<ParsedMeetingInvite> = {}, extraEvents: ParsedVEvent[] = []): ParsedMeetingInvite {
  const master: ParsedVEvent = {
    kind: overrides.kind ?? "request",
    calendarUid: overrides.calendarUid ?? "uid-series-1",
    subject: overrides.subject ?? "Weekly sync",
    organizer: overrides.organizer ?? { email: "boss@acme.com", name: "Boss" },
    attendees: overrides.attendees ?? [
      { email: "dev@acme.com", name: "Dev" },
      { email: "vendor@external.com", name: "Vendor" }
    ],
    startTime: overrides.startTime ?? "2026-06-16T14:00:00.000Z",
    endTime: overrides.endTime ?? "2026-06-16T15:00:00.000Z",
    startDateTime: overrides.startDateTime ?? { utc: "2026-06-16T14:00:00.000Z", wallClock: "2026-06-16T10:00:00", timeZone: "America/New_York" },
    sequence: overrides.sequence ?? 0,
    rrule: overrides.rrule,
    rdates: overrides.rdates,
    exdates: overrides.exdates,
    recurrenceId: overrides.recurrenceId,
    recurrenceRange: overrides.recurrenceRange
  };
  return {
    ...master,
    teamsJoinUrl: overrides.teamsJoinUrl !== undefined ? overrides.teamsJoinUrl : "https://teams.microsoft.com/l/meetup-join/abc/0",
    rawRecipient: "notetaker@acme.com",
    rawSender: "boss@acme.com",
    events: [master, ...extraEvents]
  };
}

describe("ingestParsedInvite", () => {
  it("creates a one-off event with a single occurrence and join job", async () => {
    const db = createMigratedD1();
    const outcome = await ingestParsedInvite(db, makeInvite(), settings, { now });
    expect(outcome.action).toBe("event_created");
    expect(outcome.occurrencesUpserted).toBe(1);
    expect(outcome.jobsCreated).toBe(1);

    const event = await getCalendarEventByUid(db, "uid-series-1");
    expect(event?.is_recurring).toBe(0);
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].occurrence_key).toBe("20260616T140000Z");
    // Join lead: 5 minutes before start.
    expect(occurrences[0].scheduled_join_time).toBe("2026-06-16T13:55:00.000Z");

    const jobs = await listJobs(db, { type: "schedule_join" });
    expect(jobs.length).toBe(1);
    expect(jobs[0].next_run_at).toBe("2026-06-16T13:55:00.000Z");

    const attendees = await listEventAttendees(db, event!.id);
    const vendor = attendees.find((row) => row.email === "vendor@external.com");
    expect(vendor?.is_external).toBe(1);
    expect(vendor?.recipient_eligible).toBe(0);
    const organizer = attendees.find((row) => row.email === "boss@acme.com");
    expect(organizer?.recipient_eligible).toBe(1);
  });

  it("is idempotent for duplicate invites", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite(), settings, { now });
    const second = await ingestParsedInvite(db, makeInvite(), settings, { now });
    expect(second.action).toBe("event_updated");
    expect((await listJobs(db, { type: "schedule_join" })).length).toBe(1);
    const event = await getCalendarEventByUid(db, "uid-series-1");
    expect((await listOccurrencesForEvent(db, event!.id)).length).toBe(1);
  });

  it("expands a weekly recurring series over the window", async () => {
    const db = createMigratedD1();
    const outcome = await ingestParsedInvite(db, makeInvite({ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=4" }), settings, { now });
    expect(outcome.occurrencesUpserted).toBe(4);
    expect(outcome.jobsCreated).toBe(4);
    const event = await getCalendarEventByUid(db, "uid-series-1");
    expect(event?.is_recurring).toBe(1);
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    expect(occurrences.map((row) => row.start_time)).toEqual([
      "2026-06-16T14:00:00.000Z",
      "2026-06-23T14:00:00.000Z",
      "2026-06-30T14:00:00.000Z",
      "2026-07-07T14:00:00.000Z"
    ]);
  });

  it("reschedules a moved one-off meeting and replaces its join job", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite(), settings, { now });
    const moved = await ingestParsedInvite(
      db,
      makeInvite({
        sequence: 1,
        startTime: "2026-06-17T14:00:00.000Z",
        endTime: "2026-06-17T15:00:00.000Z",
        startDateTime: { utc: "2026-06-17T14:00:00.000Z", wallClock: "2026-06-17T10:00:00", timeZone: "America/New_York" }
      }),
      settings,
      { now }
    );
    expect(moved.action).toBe("event_updated");
    const event = await getCalendarEventByUid(db, "uid-series-1");
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    // The old rule-generated occurrence is pruned; the new one is scheduled.
    const active = occurrences.filter((row) => row.status === "scheduled");
    expect(active.length).toBe(1);
    expect(active[0].start_time).toBe("2026-06-17T14:00:00.000Z");
    const pendingJobs = await listJobs(db, { type: "schedule_join", status: "pending" });
    expect(pendingJobs.length).toBe(1);
    expect(pendingJobs[0].next_run_at).toBe("2026-06-17T13:55:00.000Z");
  });

  it("ignores stale sequence replays", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite({ sequence: 3 }), settings, { now });
    const replay = await ingestParsedInvite(db, makeInvite({ sequence: 1, subject: "Old subject" }), settings, { now });
    expect(replay.action).toBe("ignored_stale");
    const event = await getCalendarEventByUid(db, "uid-series-1");
    expect(event?.subject).toBe("Weekly sync");
  });

  it("applies a single-occurrence override without disturbing siblings", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite({ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3" }), settings, { now });

    const overrideEvent: ParsedVEvent = {
      kind: "request",
      calendarUid: "uid-series-1",
      subject: "Weekly sync (moved)",
      organizer: { email: "boss@acme.com" },
      attendees: [],
      startTime: "2026-06-23T16:00:00.000Z",
      endTime: "2026-06-23T17:00:00.000Z",
      sequence: 1,
      recurrenceId: { utc: "2026-06-23T14:00:00.000Z" }
    };
    const invite: ParsedMeetingInvite = {
      ...overrideEvent,
      teamsJoinUrl: "https://teams.microsoft.com/l/meetup-join/abc/0",
      rawRecipient: "notetaker@acme.com",
      rawSender: "boss@acme.com",
      events: [overrideEvent]
    };
    const outcome = await ingestParsedInvite(db, invite, settings, { now });
    expect(outcome.action).toBe("occurrence_updated");

    const event = await getCalendarEventByUid(db, "uid-series-1");
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    const moved = occurrences.find((row) => row.occurrence_key === "20260623T140000Z");
    expect(moved?.start_time).toBe("2026-06-23T16:00:00.000Z");
    expect(moved?.is_override).toBe(1);
    expect(moved?.subject).toBe("Weekly sync (moved)");
    expect(occurrences.filter((row) => row.start_time.startsWith("2026-06-16")).length).toBe(1);

    // Re-expansion must not undo the override.
    await expandEventOccurrences(db, (await getCalendarEventByUid(db, "uid-series-1"))!, settings, { now });
    const stillMoved = await getOccurrence(db, moved!.id);
    expect(stillMoved?.start_time).toBe("2026-06-23T16:00:00.000Z");
  });

  it("cancels a single occurrence and records an EXDATE so it stays canceled", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite({ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3" }), settings, { now });

    const cancelEvent: ParsedVEvent = {
      kind: "cancel",
      calendarUid: "uid-series-1",
      subject: "Weekly sync",
      organizer: { email: "boss@acme.com" },
      attendees: [],
      startTime: "2026-06-23T14:00:00.000Z",
      endTime: "2026-06-23T15:00:00.000Z",
      sequence: 2,
      recurrenceId: { utc: "2026-06-23T14:00:00.000Z" }
    };
    const invite: ParsedMeetingInvite = {
      ...cancelEvent,
      teamsJoinUrl: null,
      rawRecipient: "notetaker@acme.com",
      rawSender: "boss@acme.com",
      events: [cancelEvent]
    };
    const outcome = await ingestParsedInvite(db, invite, settings, { now });
    expect(outcome.action).toBe("occurrences_canceled");
    expect(outcome.occurrencesCanceled).toBe(1);

    const event = await getCalendarEventByUid(db, "uid-series-1");
    expect(event?.exdates).toContain("2026-06-23T14:00:00.000Z");

    // Re-expansion must not resurrect the canceled occurrence.
    await expandEventOccurrences(db, event!, settings, { now });
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    const canceled = occurrences.find((row) => row.occurrence_key === "20260623T140000Z");
    expect(canceled?.status).toBe("canceled");
    expect(occurrences.filter((row) => row.status === "scheduled").length).toBe(2);
  });

  it("cancels a whole series including its jobs", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite({ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=3" }), settings, { now });
    const outcome = await ingestParsedInvite(db, makeInvite({ kind: "cancel", sequence: 1, teamsJoinUrl: null }), settings, { now });
    expect(outcome.action).toBe("series_canceled");
    expect(outcome.occurrencesCanceled).toBe(3);

    const event = await getCalendarEventByUid(db, "uid-series-1");
    expect(event?.status).toBe("canceled");
    expect(await listJobs(db, { type: "schedule_join", status: "pending" })).toEqual([]);
    expect((await listJobs(db, { type: "schedule_join", status: "canceled" })).length).toBe(3);
  });

  it("reports bots to cancel when a canceled occurrence has a live session", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite(), settings, { now });
    const event = await getCalendarEventByUid(db, "uid-series-1");
    const occurrence = (await listOccurrencesForEvent(db, event!.id))[0];
    await updateOccurrenceStatus(db, occurrence.id, "in_meeting", { latestBotSessionId: "bot_live" });

    const outcome = await ingestParsedInvite(db, makeInvite({ kind: "cancel", sequence: 1, teamsJoinUrl: null }), settings, { now });
    expect(outcome.botsToCancel.map((row) => row.id)).toEqual([occurrence.id]);
  });

  it("ignores cancellations and overrides for unknown series", async () => {
    const db = createMigratedD1();
    const cancel = await ingestParsedInvite(db, makeInvite({ kind: "cancel", teamsJoinUrl: null }), settings, { now });
    expect(cancel.action).toBe("ignored_unknown_event");

    const overrideEvent: ParsedVEvent = {
      kind: "request",
      calendarUid: "uid-unknown",
      subject: "Mystery",
      organizer: { email: "boss@acme.com" },
      attendees: [],
      startTime: "2026-06-23T16:00:00.000Z",
      endTime: "2026-06-23T17:00:00.000Z",
      recurrenceId: { utc: "2026-06-23T14:00:00.000Z" }
    };
    const orphan = await ingestParsedInvite(
      db,
      { ...overrideEvent, teamsJoinUrl: "https://teams.microsoft.com/l/meetup-join/x/0", rawRecipient: "r", rawSender: "s", events: [overrideEvent] },
      settings,
      { now }
    );
    expect(orphan.action).toBe("ignored_unknown_event");
  });

  it("marks past occurrences as skipped instead of scheduling joins", async () => {
    const db = createMigratedD1();
    const outcome = await ingestParsedInvite(
      db,
      makeInvite({
        startTime: "2026-06-09T14:00:00.000Z",
        endTime: "2026-06-09T15:00:00.000Z",
        startDateTime: { utc: "2026-06-09T14:00:00.000Z" }
      }),
      settings,
      { now }
    );
    expect(outcome.jobsCreated).toBe(0);
    const event = await getCalendarEventByUid(db, "uid-series-1");
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    expect(occurrences[0].status).toBe("skipped");
  });

  it("schedules an immediate join for a meeting already in progress", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(
      db,
      makeInvite({
        startTime: "2026-06-09T23:30:00.000Z",
        endTime: "2026-06-10T00:30:00.000Z",
        startDateTime: { utc: "2026-06-09T23:30:00.000Z" }
      }),
      settings,
      { now }
    );
    const jobs = await listJobs(db, { type: "schedule_join", status: "pending" });
    expect(jobs.length).toBe(1);
    expect(jobs[0].next_run_at).toBe(now.toISOString());
  });
});

describe("expandEventOccurrences maintenance", () => {
  it("rolls the window forward without duplicating occurrences or jobs", async () => {
    const db = createMigratedD1();
    await ingestParsedInvite(db, makeInvite({ rrule: "FREQ=WEEKLY;BYDAY=TU;COUNT=4" }), settings, { now });
    const event = await getCalendarEventByUid(db, "uid-series-1");
    const again = await expandEventOccurrences(db, event!, settings, { now });
    expect(again.upserted).toBe(4);
    expect(again.jobsCreated).toBe(0);
    expect((await listOccurrencesForEvent(db, event!.id)).length).toBe(4);
    expect((await listJobs(db, { type: "schedule_join" })).length).toBe(4);
  });
});
