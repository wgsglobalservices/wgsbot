import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import {
  getCalendarEventByUid,
  listAuditLogs,
  listInboundMessages,
  listJobs,
  listOccurrencesForEvent,
  saveSettings
} from "@minutesbot/db";
import { createMigratedD1 } from "../../../tests/d1Sqlite";
import { handleInbound } from "./index";

const recorder = "notetaker@minutes.bot";

async function makeEnv() {
  const db = createMigratedD1();
  await saveSettings(db, {
    ...defaultSettings,
    recorderEmail: recorder,
    allowedDomains: ["company.com"],
    email: { ...defaultSettings.email, senderEmail: recorder }
  });
  const r2Objects = new Map<string, string>();
  const queueMessages: unknown[] = [];
  const env = {
    DB: db,
    ARTIFACTS: {
      put: vi.fn(async (key: string, value: string) => {
        r2Objects.set(key, value);
      })
    } as unknown as R2Bucket,
    JOBS_QUEUE: {
      send: vi.fn(async (message: unknown) => {
        queueMessages.push(message);
      })
    }
  };
  return { db, env, r2Objects, queueMessages };
}

function futureDate(daysAhead: number, time = "140000"): string {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return `${date.toISOString().slice(0, 10).replaceAll("-", "")}T${time}Z`;
}

type EmlOptions = {
  uid?: string;
  method?: "REQUEST" | "CANCEL" | "REPLY";
  sequence?: number;
  dtstart?: string;
  dtend?: string;
  rrule?: string;
  recurrenceId?: string;
  teamsUrl?: string | null;
  organizer?: string;
  to?: string;
  messageId?: string;
};

function buildInvite(options: EmlOptions = {}): string {
  const {
    uid = "uid-email-test",
    method = "REQUEST",
    sequence = 0,
    dtstart = futureDate(5),
    dtend = futureDate(5, "150000"),
    rrule,
    recurrenceId,
    teamsUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_test/0?context=%7b%22Tid%22%3a%22t%22%7d",
    organizer = "alice@company.com",
    to = recorder,
    messageId = `msg-${Math.random().toString(36).slice(2)}`
  } = options;
  const description = teamsUrl ? `Join here: ${teamsUrl}` : "No link";
  const ics = [
    "BEGIN:VCALENDAR",
    `METHOD:${method}`,
    "PRODID:-//Microsoft//Outlook//EN",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${sequence}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    ...(recurrenceId ? [`RECURRENCE-ID:${recurrenceId}`] : []),
    "SUMMARY:Project sync",
    `ORGANIZER;CN=Alice:mailto:${organizer}`,
    "ATTENDEE;CN=Bob;ROLE=REQ-PARTICIPANT:mailto:bob@company.com",
    "ATTENDEE;CN=Vendor;ROLE=OPT-PARTICIPANT:mailto:vendor@external.org",
    ...(teamsUrl ? [`DESCRIPTION:${description}`] : []),
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  return [
    `From: Alice Organizer <${organizer}>`,
    `To: minutesbot <${to}>`,
    `Message-ID: <${messageId}@example.com>`,
    "Subject: Project sync",
    "MIME-Version: 1.0",
    `Content-Type: text/calendar; method=${method}; charset="UTF-8"`,
    "",
    ics
  ].join("\r\n");
}

function makeMessage(overrides: { from?: string; to?: string } = {}) {
  return {
    from: overrides.from ?? "alice@company.com",
    to: overrides.to ?? recorder,
    setReject: vi.fn()
  };
}

describe("email worker ingestion", () => {
  it("accepts a one-off invite: records message, raw artifact, event, occurrence, and join job", async () => {
    const { db, env, r2Objects, queueMessages } = await makeEnv();
    const message = makeMessage();
    await handleInbound(message, env, buildInvite());

    expect(message.setReject).not.toHaveBeenCalled();
    const messages = await listInboundMessages(db);
    expect(messages.length).toBe(1);
    expect(messages[0].parse_status).toBe("parsed");
    expect(messages[0].ics_uid).toBe("uid-email-test");
    expect(r2Objects.size).toBe(1);

    const event = await getCalendarEventByUid(db, "uid-email-test");
    expect(event).not.toBeNull();
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].status).toBe("scheduled");
    expect((await listJobs(db, { type: "schedule_join", status: "pending" })).length).toBe(1);
    expect(queueMessages).toContainEqual({ type: "sweep_due_jobs" });
  });

  it("deduplicates identical raw messages", async () => {
    const { db, env } = await makeEnv();
    const raw = buildInvite();
    await handleInbound(makeMessage(), env, raw);
    await handleInbound(makeMessage(), env, raw);
    expect((await listInboundMessages(db)).length).toBe(1);
    const audit = await listAuditLogs(db, { eventType: "invite.ignored" });
    expect(audit.length).toBe(1);
  });

  it("expands a recurring invite into occurrences", async () => {
    const { db, env } = await makeEnv();
    await handleInbound(makeMessage(), env, buildInvite({ rrule: "FREQ=DAILY;COUNT=5" }));
    const event = await getCalendarEventByUid(db, "uid-email-test");
    expect(event?.is_recurring).toBe(1);
    expect((await listOccurrencesForEvent(db, event!.id)).length).toBe(5);
  });

  it("rejects invites sent to the wrong recipient", async () => {
    const { db, env } = await makeEnv();
    const message = makeMessage({ to: "someoneelse@minutes.bot" });
    await handleInbound(message, env, buildInvite({ to: "someoneelse@minutes.bot" }));
    expect(message.setReject).toHaveBeenCalled();
    expect((await listInboundMessages(db))[0].parse_status).toBe("rejected");
    expect((await listInboundMessages(db))[0].rejection_reason).toContain("REJECTED_INVALID_RECIPIENT");
  });

  it("rejects request invites without a Teams URL", async () => {
    const { db, env } = await makeEnv();
    const message = makeMessage();
    await handleInbound(message, env, buildInvite({ teamsUrl: null }));
    expect(message.setReject).toHaveBeenCalled();
    expect((await listInboundMessages(db))[0].rejection_reason).toContain("REJECTED_NO_TEAMS_LINK");
  });

  it("rejects external organizers when policy demands it", async () => {
    const { db, env } = await makeEnv();
    const message = makeMessage({ from: "stranger@elsewhere.com" });
    await handleInbound(message, env, buildInvite({ organizer: "stranger@elsewhere.com" }));
    expect(message.setReject).toHaveBeenCalled();
    expect((await listInboundMessages(db))[0].rejection_reason).toContain("REJECTED_EXTERNAL_ORGANIZER");
  });

  it("rejects invites with no eligible recipients", async () => {
    const { db, env } = await makeEnv();
    await saveSettings(db, {
      ...defaultSettings,
      recorderEmail: recorder,
      allowedDomains: ["nobodyhere.com"],
      email: { ...defaultSettings.email, senderEmail: recorder },
      policy: { ...defaultSettings.policy, rejectExternalOrganizers: false }
    });
    const message = makeMessage();
    await handleInbound(message, env, buildInvite());
    expect(message.setReject).toHaveBeenCalled();
    expect((await listInboundMessages(db))[0].rejection_reason).toContain("REJECTED_NO_ELIGIBLE_RECIPIENTS");
  });

  it("ignores attendee replies without bouncing", async () => {
    const { db, env } = await makeEnv();
    const message = makeMessage();
    await handleInbound(message, env, buildInvite({ method: "REPLY" }));
    expect(message.setReject).not.toHaveBeenCalled();
    expect((await listInboundMessages(db))[0].parse_status).toBe("ignored");
  });

  it("cancels a series via METHOD:CANCEL", async () => {
    const { db, env, queueMessages } = await makeEnv();
    await handleInbound(makeMessage(), env, buildInvite({ rrule: "FREQ=DAILY;COUNT=3" }));
    await handleInbound(makeMessage(), env, buildInvite({ method: "CANCEL", sequence: 1, teamsUrl: null }));

    const event = await getCalendarEventByUid(db, "uid-email-test");
    expect(event?.status).toBe("canceled");
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    expect(occurrences.every((row) => row.status === "canceled")).toBe(true);
    expect(queueMessages.filter((m) => (m as { type: string }).type === "sweep_due_jobs").length).toBe(1);
  });

  it("cancels a single occurrence of a recurring series", async () => {
    const { db, env } = await makeEnv();
    const start = futureDate(5);
    await handleInbound(makeMessage(), env, buildInvite({ dtstart: start, dtend: futureDate(5, "150000"), rrule: "FREQ=DAILY;COUNT=3" }));
    const secondStart = futureDate(6);
    await handleInbound(
      makeMessage(),
      env,
      buildInvite({ method: "CANCEL", sequence: 1, recurrenceId: secondStart, dtstart: secondStart, dtend: futureDate(6, "150000"), teamsUrl: null })
    );

    const event = await getCalendarEventByUid(db, "uid-email-test");
    expect(event?.status).toBe("active");
    const occurrences = await listOccurrencesForEvent(db, event!.id);
    const canceled = occurrences.filter((row) => row.status === "canceled");
    expect(canceled.length).toBe(1);
    expect(occurrences.filter((row) => row.status === "scheduled").length).toBe(2);
  });

  it("records parse failures as ignored with a reason", async () => {
    const { db, env } = await makeEnv();
    const message = makeMessage();
    const broken = ["From: a@company.com", `To: ${recorder}`, "Subject: x", "Content-Type: text/calendar", "", "BEGIN:VCALENDAR\nGARBAGE"].join("\r\n");
    await handleInbound(message, env, broken);
    const rows = await listInboundMessages(db);
    expect(rows[0].parse_status).toBe("ignored");
  });
});
