import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTeamsJoinUrl, parseIncomingInvite } from "./index";

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
