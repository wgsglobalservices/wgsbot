import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { generateAndSendSummary } from "./summaryWorkflow";
import type { WorkflowEnv } from "./env";

type Row = Record<string, unknown>;

function fakeDb(options: {
  meeting: Row;
  deliveries?: Row[];
  attendees?: Row[];
  artifacts?: Row[];
}): { db: D1Database; summaryStatusUpdates: unknown[][]; emailInserts: unknown[][] } {
  const summaryStatusUpdates: unknown[][] = [];
  const emailInserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM settings")) {
            return { key: "app", value: JSON.stringify({ ...defaultSettings, email: { ...defaultSettings.email, provider: "cloudflare-email-service" } }), updated_at: new Date().toISOString() };
          }
          if (sql.includes("FROM meetings")) return options.meeting;
          return null;
        },
        async all() {
          if (sql.includes("FROM email_deliveries")) return { results: options.deliveries ?? [] };
          if (sql.includes("FROM attendees")) return { results: options.attendees ?? [] };
          if (sql.includes("FROM artifacts")) return { results: options.artifacts ?? [] };
          return { results: [] };
        },
        async run() {
          if (sql.includes("UPDATE meetings SET summary_status")) summaryStatusUpdates.push(this.values);
          if (sql.includes("INSERT INTO email_deliveries")) emailInserts.push(this.values);
          return { success: true };
        }
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  return { db, summaryStatusUpdates, emailInserts };
}

const summaryJson = JSON.stringify({
  meetingType: "general",
  recapDepth: "standard",
  summary: ["Recap line"],
  decisions: [],
  actionItems: [],
  openQuestions: [],
  risks: [],
  followUps: [],
  meetingNotes: [],
  followUpTasks: []
});

function env(db: D1Database, sendEmail: ReturnType<typeof vi.fn>): WorkflowEnv {
  return {
    DB: db,
    ARTIFACTS: {
      get: vi.fn(async () => ({ text: async () => "transcript words" })),
      put: vi.fn(async () => undefined)
    } as unknown as R2Bucket,
    INVITE_QUEUE: { send: vi.fn(async () => undefined) },
    SUMMARY_QUEUE: { send: vi.fn(async () => undefined) },
    SEND_EMAIL: { send: sendEmail },
    BOT_API_BASE_URL: "https://meeting-api.example.com",
    API_BASE_URL: "https://api.example.com",
    AI_API_KEY: "sk-test"
  };
}

const baseMeeting = {
  id: "mtg_1",
  subject: "Weekly sync",
  organizer_email: "alice@company.com",
  organizer_name: "Alice",
  start_time: "2026-05-04T15:00:00.000Z",
  end_time: "2026-05-04T15:30:00.000Z",
  status: "TRANSCRIPT_AVAILABLE",
  transcript_status: "complete",
  summary_status: "not_started"
};

const transcriptArtifact = { id: "art_1", meeting_id: "mtg_1", type: "transcript_text", r2_key: "transcripts/mtg_1/transcript.txt", deleted_at: null };
const eligibleAttendee = { id: "att_1", meeting_id: "mtg_1", email: "alice@company.com", name: "Alice", summary_eligible: 1 };

function stubAiFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: summaryJson } }] }), { status: 200, headers: { "content-type": "application/json" } }))
  );
}

describe("summary idempotency", () => {
  it("returns early without regenerating when the summary was already sent", async () => {
    const sendEmail = vi.fn();
    const aiFetch = vi.fn();
    vi.stubGlobal("fetch", aiFetch);
    const { db, summaryStatusUpdates } = fakeDb({ meeting: { ...baseMeeting, summary_status: "sent" } });

    await generateAndSendSummary(env(db, sendEmail), "mtg_1");

    expect(sendEmail).not.toHaveBeenCalled();
    expect(aiFetch).not.toHaveBeenCalled();
    expect(summaryStatusUpdates).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("skips recipients that already have a sent delivery row", async () => {
    stubAiFetch();
    const sendEmail = vi.fn(async () => ({ id: "msg-1" }));
    const { db, emailInserts } = fakeDb({
      meeting: baseMeeting,
      artifacts: [transcriptArtifact],
      attendees: [eligibleAttendee, { id: "att_2", meeting_id: "mtg_1", email: "bob@company.com", name: "Bob", summary_eligible: 1 }],
      deliveries: [{ id: "eml_1", meeting_id: "mtg_1", recipient_email: "alice@company.com", type: "summary", status: "sent" }]
    });

    await generateAndSendSummary(env(db, sendEmail), "mtg_1");

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sentTo = (sendEmail.mock.calls[0] as unknown[])[0] as { to: string };
    expect(sentTo.to).toBe("bob@company.com");
    expect(emailInserts).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("marks the summary failed when generation throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 }))
    );
    const sendEmail = vi.fn();
    const { db, summaryStatusUpdates } = fakeDb({
      meeting: baseMeeting,
      artifacts: [transcriptArtifact],
      attendees: [eligibleAttendee]
    });

    await expect(generateAndSendSummary(env(db, sendEmail), "mtg_1")).rejects.toThrow();
    expect(summaryStatusUpdates.some((values) => values[0] === "failed")).toBe(true);
    vi.unstubAllGlobals();
  });
});
