import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCalendar, parseIcsCalendar } from "./parseIcs";
import { parseIncomingInvite } from "./parseIncomingInvite";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

const wrap = (event: string, extra = "") => `BEGIN:VCALENDAR\nMETHOD:REQUEST\n${extra}BEGIN:VEVENT\n${event}\nEND:VEVENT\nEND:VCALENDAR`;

const baseEvent = [
  "UID:test-uid",
  "SUMMARY:Subject",
  "DTSTART:20260615T100000Z",
  "DTEND:20260615T103000Z",
  "ORGANIZER;CN=Alice:mailto:alice@company.com"
].join("\n");

describe("recurring invite fixtures", () => {
  it("parses a weekly recurring series master with a folded RRULE and Windows TZID", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-recurring-weekly.eml"));

    expect(invite.calendarUid).toBe("recurring-123");
    expect(invite.kind).toBe("request");
    expect(invite.sequence).toBe(0);
    // The RRULE is folded across two physical lines in the fixture.
    expect(invite.rrule).toBe("FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=1");
    expect(invite.recurrenceId).toBeUndefined();
    // June 16 is EDT (UTC-4): 10:00 local -> 14:00Z.
    expect(invite.startTime).toBe("2026-06-16T14:00:00.000Z");
    expect(invite.startDateTime).toEqual({
      utc: "2026-06-16T14:00:00.000Z",
      wallClock: "2026-06-16T10:00:00",
      timeZone: "America/New_York"
    });
    expect(invite.endDateTime?.utc).toBe("2026-06-16T14:30:00.000Z");
    expect(invite.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
    expect(invite.events).toHaveLength(1);
    expect(invite.events[0].rrule).toBe(invite.rrule);
  });

  it("parses an occurrence update with RECURRENCE-ID and a moved start time", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-occurrence-update.eml"));

    expect(invite.calendarUid).toBe("recurring-123");
    expect(invite.kind).toBe("request");
    expect(invite.sequence).toBe(1);
    expect(invite.recurrenceId).toEqual({
      utc: "2026-06-23T14:00:00.000Z",
      wallClock: "2026-06-23T10:00:00",
      timeZone: "America/New_York"
    });
    expect(invite.recurrenceRange).toBeUndefined();
    expect(invite.startTime).toBe("2026-06-23T15:30:00.000Z");
    expect(invite.events).toHaveLength(1);
  });

  it("parses a single-occurrence cancellation", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-occurrence-cancel.eml"));

    expect(invite.kind).toBe("cancel");
    expect(invite.calendarUid).toBe("recurring-123");
    expect(invite.sequence).toBe(2);
    expect(invite.recurrenceId?.utc).toBe("2026-06-30T14:00:00.000Z");
    expect(invite.teamsJoinUrl).toBeNull();
  });

  it("parses a whole-series cancellation without a RECURRENCE-ID", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-series-cancel.eml"));

    expect(invite.kind).toBe("cancel");
    expect(invite.calendarUid).toBe("recurring-123");
    expect(invite.sequence).toBe(3);
    expect(invite.recurrenceId).toBeUndefined();
  });

  it("parses a calendar containing both the series master and an override", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-master-with-override.eml"));

    // The top-level invite reflects the master event.
    expect(invite.calendarUid).toBe("recurring-123");
    expect(invite.rrule).toBe("FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=1");
    expect(invite.sequence).toBe(0);
    expect(invite.recurrenceId).toBeUndefined();
    expect(invite.exdates).toEqual([
      { utc: "2026-07-07T14:00:00.000Z", wallClock: "2026-07-07T10:00:00", timeZone: "America/New_York" }
    ]);

    // Both VEVENTs are surfaced in file order: master first, then the override.
    expect(invite.events).toHaveLength(2);
    expect(invite.events[0].rrule).toBeDefined();
    expect(invite.events[0].recurrenceId).toBeUndefined();
    expect(invite.events[1].recurrenceId?.utc).toBe("2026-07-14T14:00:00.000Z");
    expect(invite.events[1].startTime).toBe("2026-07-14T17:00:00.000Z");
    expect(invite.events[1].sequence).toBe(1);
    expect(invite.events[1].subject).toBe("Weekly project sync (moved)");
  });
});

describe("parseCalendar", () => {
  it("exposes the raw METHOD and every VEVENT in file order", () => {
    const override = baseEvent.replace("SUMMARY:Subject", "SUMMARY:Moved\nRECURRENCE-ID:20260615T100000Z");
    const ics = `BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VEVENT\n${override}\nEND:VEVENT\nBEGIN:VEVENT\n${baseEvent}\nRRULE:FREQ=DAILY\nEND:VEVENT\nEND:VCALENDAR`;
    const calendar = parseCalendar(ics);

    expect(calendar.method).toBe("REQUEST");
    expect(calendar.kind).toBe("request");
    expect(calendar.events).toHaveLength(2);
    expect(calendar.events[0].recurrenceId?.utc).toBe("2026-06-15T10:00:00.000Z");
    expect(calendar.events[1].rrule).toBe("FREQ=DAILY");

    // The single-event parser picks the master even when an override comes first.
    expect(parseIcsCalendar(ics).rrule).toBe("FREQ=DAILY");
  });
});

describe("recurrence properties", () => {
  it("unfolds an RRULE split across a folded line", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nRRULE:FREQ=WEEKLY;BYDAY=TU,\n TH;INTERVAL=2`));
    expect(event.rrule).toBe("FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=2");
  });

  it("parses EXDATE with multiple comma-separated values on one line", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nEXDATE;TZID=America/New_York:20260115T100000,20260122T100000`));
    // January is EST (UTC-5).
    expect(event.exdates).toEqual([
      { utc: "2026-01-15T15:00:00.000Z", wallClock: "2026-01-15T10:00:00", timeZone: "America/New_York" },
      { utc: "2026-01-22T15:00:00.000Z", wallClock: "2026-01-22T10:00:00", timeZone: "America/New_York" }
    ]);
  });

  it("accumulates EXDATE values across multiple lines", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nEXDATE:20260616T100000Z\nEXDATE:20260623T100000Z`));
    expect(event.exdates?.map((date) => date.utc)).toEqual(["2026-06-16T10:00:00.000Z", "2026-06-23T10:00:00.000Z"]);
  });

  it("parses RDATE with a Windows TZID param and resolves the IANA zone", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nRDATE;TZID=Pacific Standard Time:20260120T090000`));
    // January is PST (UTC-8).
    expect(event.rdates).toEqual([
      { utc: "2026-01-20T17:00:00.000Z", wallClock: "2026-01-20T09:00:00", timeZone: "America/Los_Angeles" }
    ]);
  });

  it("parses VALUE=DATE exclusion values as all-day dates", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nEXDATE;VALUE=DATE:20260616`));
    expect(event.exdates).toEqual([
      { utc: "2026-06-16T00:00:00.000Z", wallClock: "2026-06-16T00:00:00", timeZone: undefined, isDate: true }
    ]);
  });

  it("ignores RDATE;VALUE=PERIOD with a warning instead of throwing", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nRDATE;VALUE=PERIOD:20260616T100000Z/20260616T110000Z`));
    expect(event.rdates).toBeUndefined();
    expect(event.warnings).toEqual(["RDATE;VALUE=PERIOD is not supported; values ignored"]);
  });

  it("captures RANGE=THISANDFUTURE on RECURRENCE-ID", () => {
    const event = parseIcsCalendar(wrap(`${baseEvent}\nRECURRENCE-ID;TZID=America/New_York;RANGE=THISANDFUTURE:20260623T100000`));
    expect(event.recurrenceId?.utc).toBe("2026-06-23T14:00:00.000Z");
    expect(event.recurrenceRange).toBe("THISANDFUTURE");
  });

  it("leaves sequence undefined when SEQUENCE is absent or malformed", () => {
    expect(parseIcsCalendar(wrap(baseEvent)).sequence).toBeUndefined();
    expect(parseIcsCalendar(wrap(`${baseEvent}\nSEQUENCE:nonsense`)).sequence).toBeUndefined();
    expect(parseIcsCalendar(wrap(`${baseEvent}\nSEQUENCE:7`)).sequence).toBe(7);
  });

  it("keeps the structured UTC DTSTART alongside the string fields", () => {
    const event = parseIcsCalendar(wrap(baseEvent));
    expect(event.startDateTime).toEqual({ utc: "2026-06-15T10:00:00.000Z", wallClock: "2026-06-15T10:00:00", timeZone: "UTC" });
    expect(event.startTime).toBe(event.startDateTime?.utc);
  });
});
