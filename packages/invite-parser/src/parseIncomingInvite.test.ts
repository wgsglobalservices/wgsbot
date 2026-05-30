import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expandInviteOccurrences, extractTeamsJoinUrl, parseIncomingInvite } from "./index";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("invite parser", () => {
  it("parses valid Teams invites", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-basic.eml"));

    expect(invite.calendarUid).toBe("abc-123");
    expect(invite.kind).toBe("request");
    expect(invite.subject).toBe("Project sync");
    expect(invite.organizer.email).toBe("alice@company.com");
    expect(invite.rawRecipient).toBe("notetaker@meet.company.com");
    expect(invite.attendees).toEqual([
      { email: "alex@company.com", name: "Alex", role: "required" },
      { email: "vendor@example.net", name: "Vendor", role: "optional" },
      { email: "notetaker@meet.company.com", name: "minutesbot", role: undefined }
    ]);
    expect(invite.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
  });

  it("adds To and Cc recipients when the calendar attendee list is incomplete", () => {
    const invite = parseIncomingInvite(`From: Alice <alice@company.com>
To: Alex <alex@company.com>, notetaker@meet.company.com
Cc: Casey <casey@company.com>, Vendor <vendor@example.net>
Subject: Project sync

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:abc-headers
SUMMARY:Project sync
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`);

    expect(invite.attendees).toEqual([
      { email: "alex@company.com", name: "Alex", role: "required" },
      { email: "notetaker@meet.company.com" },
      { email: "casey@company.com", name: "Casey" },
      { email: "vendor@example.net", name: "Vendor" }
    ]);
  });

  it("maps updates to the same calendar UID", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-update.eml"));
    expect(invite.calendarUid).toBe("abc-123");
    expect(invite.subject).toBe("Project sync updated");
  });

  it("parses cancellations", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-cancel.eml"));
    expect(invite.kind).toBe("cancel");
  });

  it("expands recurring Teams invites into upcoming occurrences", () => {
    const invite = parseIncomingInvite(`From: Alice <alice@company.com>
To: notetaker@meet.company.com
Subject: Recurring project sync

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:abc-recurring
SUMMARY:Recurring project sync
DTSTART:20260601T150000Z
DTEND:20260601T153000Z
RRULE:FREQ=WEEKLY;COUNT=4;INTERVAL=1;BYDAY=MO
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3arecurring%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`);

    const occurrences = expandInviteOccurrences(invite, { now: new Date("2026-05-30T12:00:00.000Z"), horizonDays: 60 });

    expect(invite.recurrence).toEqual({ frequency: "weekly", interval: 1, count: 4, byDay: ["MO"] });
    expect(occurrences.map((occurrence) => [occurrence.calendarUid, occurrence.startTime, occurrence.endTime])).toEqual([
      ["abc-recurring:20260601T150000Z", "2026-06-01T15:00:00.000Z", "2026-06-01T15:30:00.000Z"],
      ["abc-recurring:20260608T150000Z", "2026-06-08T15:00:00.000Z", "2026-06-08T15:30:00.000Z"],
      ["abc-recurring:20260615T150000Z", "2026-06-15T15:00:00.000Z", "2026-06-15T15:30:00.000Z"],
      ["abc-recurring:20260622T150000Z", "2026-06-22T15:00:00.000Z", "2026-06-22T15:30:00.000Z"]
    ]);
  });

  it("expands every BYDAY occurrence in recurring Teams invites", () => {
    const invite = parseIncomingInvite(`From: Alice <alice@company.com>
To: notetaker@meet.company.com
Subject: Recurring standup

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:abc-weekdays
SUMMARY:Recurring standup
DTSTART:20260601T150000Z
DTEND:20260601T153000Z
RRULE:FREQ=WEEKLY;COUNT=5;INTERVAL=1;BYDAY=MO,WE,FR
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3aweekdays%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`);

    const occurrences = expandInviteOccurrences(invite, { now: new Date("2026-05-30T12:00:00.000Z"), horizonDays: 14 });

    expect(occurrences.map((occurrence) => [occurrence.calendarUid, occurrence.startTime, occurrence.endTime])).toEqual([
      ["abc-weekdays:20260601T150000Z", "2026-06-01T15:00:00.000Z", "2026-06-01T15:30:00.000Z"],
      ["abc-weekdays:20260603T150000Z", "2026-06-03T15:00:00.000Z", "2026-06-03T15:30:00.000Z"],
      ["abc-weekdays:20260605T150000Z", "2026-06-05T15:00:00.000Z", "2026-06-05T15:30:00.000Z"],
      ["abc-weekdays:20260608T150000Z", "2026-06-08T15:00:00.000Z", "2026-06-08T15:30:00.000Z"],
      ["abc-weekdays:20260610T150000Z", "2026-06-10T15:00:00.000Z", "2026-06-10T15:30:00.000Z"]
    ]);
  });

  it("rejects non-Teams calendar invites and malformed calendars cleanly", () => {
    expect(() => parseIncomingInvite(readFixture("non-teams-calendar.eml"))).toThrow("Microsoft Teams");
    expect(() => parseIncomingInvite(readFixture("malformed-calendar.eml"))).toThrow("missing required");
  });

  it("decodes escaped Teams URLs", () => {
    expect(extractTeamsJoinUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%7d")).toContain(
      "teams.microsoft.com/l/meetup-join"
    );
  });

  it("parses plain forwarded Teams links as immediate meetings", () => {
    const raw = `From: Peter <p.gustafson@wgsglobalservices.com>
To: notetaker@wgs.bot
Subject: Join Teams meeting in progress

Please join https://teams.microsoft.com/l/meetup-join/19%3alink%40thread.v2/0?context=%7b%7d`;

    const first = parseIncomingInvite(raw);
    const second = parseIncomingInvite(raw);

    expect(first.kind).toBe("request");
    expect(first.subject).toBe("Join Teams meeting in progress");
    expect(first.organizer.email).toBe("p.gustafson@wgsglobalservices.com");
    expect(first.attendees).toEqual([{ email: "notetaker@wgs.bot", name: undefined, role: undefined }]);
    expect(first.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
    expect(first.calendarUid).toBe(second.calendarUid);
    expect(new Date(first.endTime).getTime() - new Date(first.startTime).getTime()).toBe(60 * 60 * 1000);
  });

  it("still rejects plain emails without Teams links", () => {
    expect(() =>
      parseIncomingInvite(`From: Peter <p.gustafson@wgsglobalservices.com>
To: notetaker@wgs.bot
Subject: TEST

hello`)
    ).toThrow("calendar payload");
  });
});
