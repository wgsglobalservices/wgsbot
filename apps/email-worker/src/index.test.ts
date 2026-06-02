import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { handleInvite } from "./index";

class FakeD1 {
  meetings: unknown[][] = [];
  attendees: unknown[][] = [];
  auditEvents: unknown[][] = [];
  statusUpdates: Array<{ status: string; latestError: string | null; meetingId: string }> = [];
  seriesCancellations: Array<{ prefix: string; keepCalendarUids: string[] }> = [];
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
        if (sql.includes("calendar_uid LIKE") && sql.includes("calendar_uid NOT IN")) {
          db.seriesCancellations.push({ prefix: this.values[3] as string, keepCalendarUids: this.values.slice(4, -1) as string[] });
        }
        if (sql.startsWith("UPDATE meetings SET status")) {
          db.statusUpdates.push({ status: this.values[0] as string, latestError: this.values[1] as string | null, meetingId: this.values[3] as string });
        }
        return { success: true };
      },
      async all() {
        return { results: [] };
      }
    };
  }
}

describe("email worker invite handling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
      { from: "p.gustafson@wgsglobalservices.com", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Peter <p.gustafson@wgsglobalservices.com>
To: notetaker@wgs.bot
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
      { from: "p.gustafson@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Peter <p.gustafson@wgs.bot>
To: notetaker@wgs.bot
Subject: Join Teams meeting in progress

https://teams.microsoft.com/l/meetup-join/19%3alink%40thread.v2/0?context=%7b%7d`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
    expect(db.meetings[0][2]).toBe("Join Teams meeting in progress");
    expect(db.meetings[0][3]).toBe("p.gustafson@wgs.bot");
    expect(db.attendees[0][2]).toBe("p.gustafson@wgs.bot");
    expect(db.attendees[0][6]).toBe(1);
  });

  it("marks future meetings as waiting for the configured early-join time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:30:00.000Z"));
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1(
      JSON.stringify({
        ...defaultSettings,
        attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-future-waiting
SUMMARY:Future Test
DTSTART:20260518T150000Z
DTEND:20260518T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).not.toHaveBeenCalled();
    expect(db.statusUpdates.at(-1)).toMatchObject({ status: "WAITING_TO_CREATE_BOT" });
  });

  it("waits when a calendar invite arrives before the actual meeting start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:56:00.000Z"));
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1(
      JSON.stringify({
        ...defaultSettings,
        attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-start-time-waiting
SUMMARY:Start Time Test
DTSTART:20260518T150000Z
DTEND:20260518T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3astart%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).not.toHaveBeenCalled();
    expect(db.statusUpdates.at(-1)).toMatchObject({ status: "WAITING_TO_CREATE_BOT" });
  });

  it("creates visible future meeting rows for each recurring invite occurrence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1(
      JSON.stringify({
        ...defaultSettings,
        attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-recurring
SUMMARY:Recurring Test
DTSTART:20260601T150000Z
DTEND:20260601T153000Z
RRULE:FREQ=WEEKLY;COUNT=3;INTERVAL=1;BYDAY=MO
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3arecurring%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).not.toHaveBeenCalled();
    expect(db.meetings.map((values) => [values[1], values[6]])).toEqual([
      ["test-recurring:20260601T150000Z", "2026-06-01T15:00:00.000Z"],
      ["test-recurring:20260608T150000Z", "2026-06-08T15:00:00.000Z"],
      ["test-recurring:20260615T150000Z", "2026-06-15T15:00:00.000Z"]
    ]);
    expect(db.statusUpdates).toHaveLength(3);
    expect(db.statusUpdates.every((update) => update.status === "WAITING_TO_CREATE_BOT")).toBe(true);
  });

  it("creates future rows from weekly Outlook forwarded link-only meeting emails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T14:23:24.000Z"));
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1(
      JSON.stringify({
        ...defaultSettings,
        allowedDomains: ["wgsglobalservices.com"],
        attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "p.gustafson@wgsglobalservices.com", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Peter <p.gustafson@wgsglobalservices.com>
To: notetaker@wgs.bot
Date: Mon, 1 Jun 2026 10:23:24 -0400
Subject: FW: Weekly Sales Meeting

When: Monday, June 1, 2026 10:30 AM-11:15 AM.
Where: Microsoft Teams Meeting

https://teams.microsoft.com/l/meetup-join/19%3aweekly%40thread.v2/0?context=%7b%7d`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).not.toHaveBeenCalled();
    const storedMeetings = db.meetings.map((values) => [values[1], values[2], values[6], values[7]]);
    expect(storedMeetings.slice(0, 3)).toEqual([
      [expect.stringMatching(/^teams-link-[a-f0-9]+:20260601T143000Z$/), "Weekly Sales Meeting", "2026-06-01T14:30:00.000Z", "2026-06-01T15:15:00.000Z"],
      [expect.stringMatching(/^teams-link-[a-f0-9]+:20260608T143000Z$/), "Weekly Sales Meeting", "2026-06-08T14:30:00.000Z", "2026-06-08T15:15:00.000Z"],
      [expect.stringMatching(/^teams-link-[a-f0-9]+:20260615T143000Z$/), "Weekly Sales Meeting", "2026-06-15T14:30:00.000Z", "2026-06-15T15:15:00.000Z"]
    ]);
    expect(storedMeetings.length).toBeGreaterThan(3);
  });

  it("cancels stale future occurrence rows when a recurring series time changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T12:00:00.000Z"));
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1(
      JSON.stringify({
        ...defaultSettings,
        attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-recurring-update
SUMMARY:Recurring Test Updated
DTSTART:20260601T160000Z
DTEND:20260601T163000Z
RRULE:FREQ=WEEKLY;COUNT=2;INTERVAL=1;BYDAY=MO
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3arecurring-update%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(db.seriesCancellations).toHaveLength(1);
    expect(db.seriesCancellations[0]).toMatchObject({
      prefix: "test-recurring-update:%",
      keepCalendarUids: ["test-recurring-update:20260601T160000Z", "test-recurring-update:20260608T160000Z"]
    });
  });

  it("rejects wrong recorder recipient", async () => {
    const setReject = vi.fn();
    const env = {
      DB: new FakeD1() as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: vi.fn(async () => undefined) }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "wrong@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: wrong@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test
SUMMARY:Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
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
        recorderAliasEmails: ["sales-notes@wgs.bot", "plant-notes@wgs.bot"]
      })
    );
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "sales-notes@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: sales-notes@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-alias
SUMMARY:Alias Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
  });

  it("stamps direct sales recap mailbox invites as weekly sales recaps", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "sales-recap@wgs.services", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: sales-recap@wgs.services

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-sales-direct
SUMMARY:Weekly Sales
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
ATTENDEE;CN=Sales Recap;ROLE=REQ-PARTICIPANT:mailto:sales-recap@wgs.services
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3asales%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
    expect(db.meetings[0][17]).toBe("weekly_sales");
    expect(db.meetings[0][18]).toBe("sales-recap@wgs.services");
    expect(db.attendees.map((values) => values[2])).not.toContain("sales-recap@wgs.services");
  });

  it("stamps Microsoft 365 redirected sales recap invites from original-recipient headers", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite }
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot
X-Original-To: sales-recap@wgs.services

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-sales-redirect
SUMMARY:Weekly Sales Redirect
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
ATTENDEE;CN=Sales Recap;ROLE=REQ-PARTICIPANT:mailto:sales-recap@wgs.services
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3asalesredirect%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
    expect(db.meetings[0][17]).toBe("weekly_sales");
    expect(db.meetings[0][18]).toBe("sales-recap@wgs.services");
    expect(db.attendees.map((values) => values[2])).not.toContain("sales-recap@wgs.services");
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
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: Alice <alice@wgs.bot>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-forward
SUMMARY:Forwarded Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
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
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: Alex <alex@wgs.bot>, notetaker@wgs.bot
Cc: Casey <casey@wgs.bot>, Vendor <vendor@example.net>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-header-recipients
SUMMARY:Header Recipients
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(db.attendees.map((values) => [values[2], values[6], values[7]])).toEqual([
      ["alice@wgs.bot", 1, null],
      ["alex@wgs.bot", 1, null],
      ["casey@wgs.bot", 1, null],
      ["vendor@example.net", 0, "excluded_external_domain"]
    ]);
  });

  it("rejects unauthenticated production invites before queueing bots", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite },
      ENVIRONMENT: "production"
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-unauthenticated
SUMMARY:Forged Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).toHaveBeenCalledWith("Inbound sender authentication did not pass or does not align with the organizer");
    expect(queueInvite).not.toHaveBeenCalled();
    expect(db.meetings).toHaveLength(0);
  });

  it("accepts production invites with aligned DMARC authentication", async () => {
    const setReject = vi.fn();
    const queueInvite = vi.fn(async () => undefined);
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: queueInvite },
      ENVIRONMENT: "production"
    };

    await handleInvite(
      { from: "alice@wgs.bot", to: "notetaker@wgs.bot", setReject },
      env,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=wgs.bot; spf=pass smtp.mailfrom=wgs.bot; dkim=pass header.d=wgs.bot
From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-authenticated
SUMMARY:Authenticated Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).not.toHaveBeenCalled();
    expect(queueInvite).toHaveBeenCalledWith(expect.objectContaining({ type: "create_bot", meetingId: expect.stringMatching(/^mtg_/) }));
  });

  it("rejects production invites when the authenticated sender and organizer domains differ", async () => {
    const setReject = vi.fn();
    const env = {
      DB: new FakeD1() as unknown as D1Database,
      ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
      INVITE_QUEUE: { send: vi.fn(async () => undefined) },
      ENVIRONMENT: "production"
    };

    await handleInvite(
      { from: "attacker@example.net", to: "notetaker@wgs.bot", setReject },
      env,
      `Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.net
From: Mallory <attacker@example.net>
To: notetaker@wgs.bot

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-auth-mismatch
SUMMARY:Mismatch Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`
    );

    expect(setReject).toHaveBeenCalledWith("Inbound sender authentication did not pass or does not align with the organizer");
  });
});
