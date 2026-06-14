import { describe, expect, it } from "vitest";
import { parseIcsCalendar } from "./parseIcs";
import { parseIcsDate, parseUtcOffsetToMinutes } from "./icsDates";

const wrap = (event: string, extra = "") => `BEGIN:VCALENDAR\nMETHOD:REQUEST\n${extra}BEGIN:VEVENT\n${event}\nEND:VEVENT\nEND:VCALENDAR`;

const baseEvent = [
  "UID:test-uid",
  "SUMMARY:Subject",
  "DTSTART:20260615T100000Z",
  "DTEND:20260615T103000Z",
  "ORGANIZER;CN=Alice:mailto:alice@company.com"
].join("\n");

describe("parseIcsCalendar", () => {
  it("reads DTSTART from the VEVENT, not from a preceding VTIMEZONE block", () => {
    const vtimezone = [
      "BEGIN:VTIMEZONE",
      "TZID:Eastern Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "END:STANDARD",
      "END:VTIMEZONE",
      ""
    ].join("\n");
    const calendar = parseIcsCalendar(wrap(baseEvent, vtimezone));

    expect(calendar.startTime).toBe("2026-06-15T10:00:00.000Z");
    expect(calendar.startTime).not.toContain("1601");
  });

  it("converts TZID local times to UTC for Windows time zone names", () => {
    const event = baseEvent.replace("DTSTART:20260615T100000Z", "DTSTART;TZID=Eastern Standard Time:20260615T100000");
    const calendar = parseIcsCalendar(wrap(event));

    // June 15 is EDT (UTC-4): 10:00 local -> 14:00Z.
    expect(calendar.startTime).toBe("2026-06-15T14:00:00.000Z");
  });

  it("converts TZID local times to UTC for IANA zone ids across DST", () => {
    const winter = baseEvent
      .replace("DTSTART:20260615T100000Z", "DTSTART;TZID=America/New_York:20260115T100000")
      .replace("DTEND:20260615T103000Z", "DTEND;TZID=America/New_York:20260115T103000");
    const calendar = parseIcsCalendar(wrap(winter));

    // January is EST (UTC-5).
    expect(calendar.startTime).toBe("2026-01-15T15:00:00.000Z");
  });

  it("falls back to the VTIMEZONE standard offset for unknown TZIDs", () => {
    const vtimezone = [
      "BEGIN:VTIMEZONE",
      "TZID:Customized Time Zone",
      "BEGIN:STANDARD",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:+0500",
      "TZOFFSETTO:+0530",
      "END:STANDARD",
      "END:VTIMEZONE",
      ""
    ].join("\n");
    const event = baseEvent.replace("DTSTART:20260615T100000Z", "DTSTART;TZID=Customized Time Zone:20260615T100000");
    const calendar = parseIcsCalendar(wrap(event, vtimezone));

    expect(calendar.startTime).toBe("2026-06-15T04:30:00.000Z");
  });

  it("accepts VALUE=DATE all-day values instead of throwing", () => {
    const event = baseEvent.replace("DTSTART:20260615T100000Z", "DTSTART;VALUE=DATE:20260615");
    const calendar = parseIcsCalendar(wrap(event));

    expect(calendar.startTime).toBe("2026-06-15T00:00:00.000Z");
  });

  it("parses quoted parameter values containing colons and semicolons", () => {
    const event = baseEvent.replace('ORGANIZER;CN=Alice:mailto:alice@company.com', 'ORGANIZER;CN="Smith: John; Jr":mailto:john@company.com');
    const calendar = parseIcsCalendar(wrap(event));

    expect(calendar.organizer.email).toBe("john@company.com");
    expect(calendar.organizer.name).toBe("Smith: John; Jr");
  });

  it("classifies attendee replies as non-actionable", () => {
    const calendar = parseIcsCalendar(wrap(baseEvent).replace("METHOD:REQUEST", "METHOD:REPLY"));
    expect(calendar.kind).toBe("other");
  });

  it("parses cancellations with only a UID", () => {
    const cancel = "BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:cancel-only\nEND:VEVENT\nEND:VCALENDAR";
    const calendar = parseIcsCalendar(cancel);

    expect(calendar.kind).toBe("cancel");
    expect(calendar.calendarUid).toBe("cancel-only");
    expect(calendar.subject).toBe("");
    expect(calendar.startTime).toBe("");
  });
});

describe("parseIcsDate", () => {
  it("treats floating times without TZID as UTC", () => {
    expect(parseIcsDate("20260615T100000", new Map())).toBe("2026-06-15T10:00:00.000Z");
  });

  it("degrades unknown TZIDs to UTC instead of rejecting the invite", () => {
    expect(parseIcsDate("20260615T100000", new Map([["TZID", "Totally Unknown Zone"]]))).toBe("2026-06-15T10:00:00.000Z");
  });

  it("rejects garbage date values", () => {
    expect(() => parseIcsDate("not-a-date", new Map())).toThrow("Unsupported calendar date");
  });
});

describe("parseUtcOffsetToMinutes", () => {
  it("parses signed hour/minute offsets", () => {
    expect(parseUtcOffsetToMinutes("+0530")).toBe(330);
    expect(parseUtcOffsetToMinutes("-0500")).toBe(-300);
    expect(parseUtcOffsetToMinutes("+02")).toBe(120);
    expect(parseUtcOffsetToMinutes("nonsense")).toBeUndefined();
  });
});
