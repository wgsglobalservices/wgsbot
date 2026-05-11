import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTeamsJoinUrl, normalizeTeamsJoinUrl, parseIncomingInvite } from "./index";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("invite parser", () => {
  it("parses valid Teams invites", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-basic.eml"));

    expect(invite.calendarUid).toBe("abc-123");
    expect(invite.kind).toBe("request");
    expect(invite.subject).toBe("Project sync");
    expect(invite.organizer.email).toBe("alice@company.com");
    expect(invite.rawRecipient).toBe("notetaker@minutes.bot");
    expect(invite.attendees).toEqual([
      { email: "alex@company.com", name: "Alex", role: "required" },
      { email: "vendor@example.net", name: "Vendor", role: "optional" },
      { email: "notetaker@minutes.bot", name: "minutesbot", role: undefined }
    ]);
    expect(invite.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
  });

  it("adds To and Cc recipients when the calendar attendee list is incomplete", () => {
    const invite = parseIncomingInvite(`From: Alice <alice@company.com>
To: Alex <alex@company.com>, notetaker@minutes.bot
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
      { email: "notetaker@minutes.bot" },
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

  it("normalizes direct Teams meetup links across supported Teams hosts", () => {
    expect(normalizeTeamsJoinUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%7d;")).toBe(
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%7d"
    );
    expect(normalizeTeamsJoinUrl("https://teams.live.com/l/meetup-join/19%3alive%40thread.v2/0?context=%7b%7d")).toBe(
      "https://teams.live.com/l/meetup-join/19%3alive%40thread.v2/0?context=%7b%7d"
    );
  });

  it("normalizes Teams v2 fragment and launcher links to canonical meetup links", () => {
    expect(
      extractTeamsJoinUrl(
        "Join https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%7d&anon=true"
      )
    ).toBe("https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%7d&anon=true");

    expect(
      extractTeamsJoinUrl(
        "Join https://teams.microsoft.com/dl/launcher/launcher.html?url=/_#/l/meetup-join/19%3alauncher%40thread.v2/0?context=%7b%7d"
      )
    ).toBe("https://teams.microsoft.com/l/meetup-join/19%3alauncher%40thread.v2/0?context=%7b%7d");
  });

  it("normalizes light-meetings coords links into canonical meetup links", () => {
    const coords = btoa(
      JSON.stringify({
        conversationId: "19:meeting_abc@thread.v2",
        tenantId: "tenant-id",
        organizerId: "organizer-id",
        messageId: "0"
      })
    );

    expect(extractTeamsJoinUrl(`https://teams.microsoft.com/light-meetings/launch?agent=web&coords=${encodeURIComponent(coords)}`)).toBe(
      'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_abc%40thread.v2/0?context=%7B%22Tid%22%3A%22tenant-id%22%2C%22Oid%22%3A%22organizer-id%22%7D'
    );
  });

  it("keeps short Teams meet links with passcodes as cleaned absolute URLs", () => {
    expect(extractTeamsJoinUrl("https://teams.microsoft.com/meet/2680357125718?p=XE7jU7Jh,")).toBe(
      "https://teams.microsoft.com/meet/2680357125718?p=XE7jU7Jh"
    );
  });

  it("continues scanning when a light-meetings coords link is malformed", () => {
    expect(
      extractTeamsJoinUrl(
        "Broken https://teams.microsoft.com/light-meetings/launch?coords=not-base64 then https://teams.microsoft.com/l/meetup-join/19%3afallback%40thread.v2/0?context=%7b%7d"
      )
    ).toBe("https://teams.microsoft.com/l/meetup-join/19%3afallback%40thread.v2/0?context=%7b%7d");
  });

  it("parses plain forwarded Teams links as immediate meetings", () => {
    const raw = `From: Peter <p.gustafson@company.com>
To: notetaker@minutes.bot
Subject: Join Teams meeting in progress

Please join https://teams.microsoft.com/l/meetup-join/19%3alink%40thread.v2/0?context=%7b%7d`;

    const first = parseIncomingInvite(raw);
    const second = parseIncomingInvite(raw);

    expect(first.kind).toBe("request");
    expect(first.subject).toBe("Join Teams meeting in progress");
    expect(first.organizer.email).toBe("p.gustafson@company.com");
    expect(first.attendees).toEqual([{ email: "notetaker@minutes.bot", name: undefined, role: undefined }]);
    expect(first.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
    expect(first.calendarUid).toBe(second.calendarUid);
    expect(new Date(first.endTime).getTime() - new Date(first.startTime).getTime()).toBe(60 * 60 * 1000);
  });

  it("parses link-only Teams light-meetings invites into teamsJoinUrl", () => {
    const coords = btoa(
      JSON.stringify({
        conversationId: "19:meeting_link_only@thread.v2",
        tenantId: "tenant-id",
        organizerId: "organizer-id"
      })
    );
    const invite = parseIncomingInvite(`From: Peter <p.gustafson@company.com>
To: notetaker@minutes.bot
Subject: Join Teams meeting

Please join https://teams.microsoft.com/light-meetings/launch?agent=web&coords=${encodeURIComponent(coords)}`);

    expect(invite.teamsJoinUrl).toContain("https://teams.microsoft.com/l/meetup-join/19%3Ameeting_link_only%40thread.v2/0");
  });

  it("still rejects plain emails without Teams links", () => {
    expect(() =>
      parseIncomingInvite(`From: Peter <p.gustafson@company.com>
To: notetaker@minutes.bot
Subject: TEST

hello`)
    ).toThrow("calendar payload");
  });
});
