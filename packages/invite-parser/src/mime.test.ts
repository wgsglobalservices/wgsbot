import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeMimeWords, extractCalendarText, extractTextBody } from "./mime";
import { parseIncomingInvite } from "./parseIncomingInvite";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("mime decoding", () => {
  it("decodes base64 text/calendar parts", () => {
    const raw = readFixture("teams-invite-base64.eml");
    const calendar = extractCalendarText(raw);

    expect(calendar).toContain("BEGIN:VCALENDAR");
    expect(calendar).toContain("UID:b64-123");

    const invite = parseIncomingInvite(raw);
    expect(invite.calendarUid).toBe("b64-123");
    expect(invite.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
  });

  it("decodes quoted-printable text parts", () => {
    const raw = readFixture("teams-invite-base64.eml");
    const body = extractTextBody(raw);

    expect(body).toContain("Café agenda attached.");
  });

  it("decodes RFC 2047 encoded words in both Q and B encodings", () => {
    expect(decodeMimeWords("=?utf-8?q?Caf=C3=A9_meeting?=")).toBe("Café meeting");
    expect(decodeMimeWords("=?utf-8?B?Sm9zw6k=?=")).toBe("José");
    // Whitespace between adjacent encoded words is removed.
    expect(decodeMimeWords("=?utf-8?q?Hello?= =?utf-8?q?_World?=")).toBe("Hello World");
    // Unknown charsets degrade gracefully instead of throwing.
    expect(decodeMimeWords("=?x-nonsense?q?abc?=")).toBe("abc");
  });

  it("falls back to raw scanning for bare calendar bodies", () => {
    const raw = "From: a@b.c\nTo: d@e.f\n\nBEGIN:VCALENDAR\nMETHOD:REQUEST\nEND:VCALENDAR";
    expect(extractCalendarText(raw)).toContain("BEGIN:VCALENDAR");
  });
});

describe("cancel handling", () => {
  it("accepts cancellations without a Teams join URL", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-cancel-no-link.eml"));

    expect(invite.kind).toBe("cancel");
    expect(invite.calendarUid).toBe("abc-123");
    expect(invite.teamsJoinUrl).toBeNull();
  });
});

describe("vtimezone fixture end to end", () => {
  it("parses an Outlook-style invite with a VTIMEZONE block and quoted CN", () => {
    const invite = parseIncomingInvite(readFixture("teams-invite-vtimezone.eml"));

    expect(invite.calendarUid).toBe("vtz-123");
    // June 15 is EDT (UTC-4): 10:00 local -> 14:00Z.
    expect(invite.startTime).toBe("2026-06-15T14:00:00.000Z");
    expect(invite.organizer.email).toBe("alice@company.com");
    expect(invite.organizer.name).toBe("Smith: Alice");
    expect(invite.teamsJoinUrl).toContain("teams.microsoft.com/l/meetup-join");
  });
});
