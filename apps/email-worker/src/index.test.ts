import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { handleInvite } from "./index";

class FakeD1 {
  meetings: unknown[][] = [];
  attendees: unknown[][] = [];
  auditEvents: unknown[][] = [];
  settingValue: string | null;

  constructor(settingValue: string | null = null) {
    this.settingValue = settingValue;
  }

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind() {
        this.values = Array.from(arguments);
        return this;
      },
      async first() {
        if (sql.includes("FROM settings") && db.settingValue) {
          return { key: "app", value: db.settingValue, updated_at: new Date().toISOString() };
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT OR REPLACE INTO meetings")) db.meetings.push(this.values);
        if (sql.includes("INSERT INTO attendees")) db.attendees.push(this.values);
        if (sql.includes("INSERT INTO audit_logs")) db.auditEvents.push(this.values);
        return { success: true };
      },
      async all() {
        return { results: [] };
      }
    };
  }
}

describe("email worker invite handling", () => {
  it("accepts non-calendar test emails without an SMTP rejection", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "p.gustafson@example.net", to: "notetaker@minutes.bot", setReject },
      env,
      `From: Peter <p.gustafson@example.net>
To: notetaker@minutes.bot
Subject: TEST

hello`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).not.toHaveBeenCalled();
    expect(db.auditEvents.some((values) => values[2] === "invite.ignored")).toBe(true);
  });

  it("schedules link-only Teams emails immediately with the sender as recipient", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "p.gustafson@company.com", to: "notetaker@minutes.bot", setReject },
      env,
      `From: Peter <p.gustafson@company.com>
To: notetaker@minutes.bot
Subject: Join Teams meeting in progress

https://teams.microsoft.com/l/meetup-join/19%3alink%40thread.v2/0?context=%7b%7d`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
    expect(db.meetings[0][2]).toBe("Join Teams meeting in progress");
    expect(db.meetings[0][3]).toBe("p.gustafson@company.com");
    expect(db.attendees[0][2]).toBe("p.gustafson@company.com");
    expect(db.attendees[0][6]).toBe(1);
  });

  it("rejects wrong recorder recipient", async () => {
    const setReject = vi.fn();
    const env = {
      DB: new FakeD1() as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: vi.fn(async () => undefined) }
    };

    await handleInvite(
      { from: "alice@company.com", to: "wrong@company.com", setReject },
      env,
      `From: Alice <alice@company.com>
To: wrong@company.com

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test
SUMMARY:Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).toHaveBeenCalledWith("Inbound recipient does not match configured recorder email");
  });

  it("accepts configured notetaker alias recipients", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1(
      JSON.stringify({
        ...defaultSettings,
        recorderAliasEmails: ["sales-notes@meet.company.com", "plant-notes@meet.company.com"]
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@company.com", to: "sales-notes@meet.company.com", setReject },
      env,
      `From: Alice <alice@company.com>
To: sales-notes@meet.company.com

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-alias
SUMMARY:Alias Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
  });

  it("uses the envelope recipient for forwarded Teams invites", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const env = {
      DB: new FakeD1() as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@company.com", to: "notetaker@minutes.bot", setReject },
      env,
      `From: Alice <alice@company.com>
To: Alice <alice@company.com>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-forward
SUMMARY:Forwarded Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
  });

  it("stores domain-eligible To and Cc invitees while excluding the notetaker mailbox", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@company.com", to: "notetaker@minutes.bot", setReject },
      env,
      `From: Alice <alice@company.com>
To: Alex <alex@company.com>, notetaker@minutes.bot
Cc: Casey <casey@company.com>, Vendor <vendor@example.net>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-header-recipients
SUMMARY:Header Recipients
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(db.attendees.map((values) => [values[2], values[6], values[7]])).toEqual([
      ["alice@company.com", 1, null],
      ["alex@company.com", 1, null],
      ["casey@company.com", 1, null],
      ["vendor@example.net", 0, "excluded_external_domain"]
    ]);
  });
});
