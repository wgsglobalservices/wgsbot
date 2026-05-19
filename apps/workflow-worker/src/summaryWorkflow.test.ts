import { defaultSettings, verifyTranscriptDownloadToken } from "@minutesbot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateAndSendSingleRecipientSummary, generateAndSendSummary, generateAndStoreSummary } from "./summaryWorkflow";
import { summarizeTranscript } from "@minutesbot/summary-engine";

vi.mock("@minutesbot/summary-engine", () => ({
  createOpenAiCompatibleProvider: vi.fn(() => ({})),
  meetingRecapTypeLabels: {
    weekly_spqrc: "Weekly SPQRC",
    weekly_sales: "Weekly Sales",
    plant_meeting: "Individual Plant Meeting",
    general: "General"
  },
  summarizeTranscript: vi.fn(async () => ({
    meetingType: "general",
    recapDepth: "standard",
    meetingNotes: [],
    followUpTasks: [],
    summary: ["Summary ready."],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    risks: [],
    followUps: []
  }))
}));

class FakeD1 {
  emailDeliveries: unknown[][] = [];
  summaryStatuses: unknown[][] = [];

  constructor(private readonly settings = defaultSettings) {}

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings")) {
          return {
            id: "mtg_1",
            subject: "Project Sync",
            organizer_email: "owner@wgs.bot",
            organizer_name: "Owner",
            start_time: "2026-05-04T15:00:00.000Z",
            end_time: "2026-05-04T15:02:00.000Z"
          };
        }
        if (sql.includes("FROM settings")) {
          return {
            key: "app",
            value: JSON.stringify({
              ...db.settings,
              primaryDomain: "wgs.bot",
              allowedDomains: ["partner.com"],
              policy: { ...db.settings.policy, allowSubdomains: true },
              email: { ...db.settings.email, provider: "cloudflare-email-service" }
            }),
            updated_at: "2026-05-04T00:00:00.000Z"
          };
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM artifacts")) {
          return { results: [{ type: "transcript_text", r2_key: "transcripts/mtg_1/transcript.txt", deleted_at: null }] };
        }
        if (sql.includes("FROM attendees")) {
          return {
            results: [
              { email: "alex@team.wgs.bot", name: "Alex", summary_eligible: 1 },
              { email: "casey@partner.com", name: "Casey", summary_eligible: 1 },
              { email: "no-show@wgs.bot", name: "Invited No Show", summary_eligible: 1 },
              { email: "do-not-send@partner.com", name: "Stored Ineligible", summary_eligible: 0, exclusion_reason: "excluded_external_domain" },
              { email: "vendor@example.net", name: "Vendor", summary_eligible: 0 }
            ]
          };
        }
        if (sql.includes("FROM transcript_segments")) {
          return {
            results: [
              { speaker_name: "Alex", timestamp_ms: 0, duration_ms: 30_000, text: "hello" },
              { speaker_name: "Casey", timestamp_ms: 45_000, duration_ms: 30_000, text: "status update" }
            ]
          };
        }
        return { results: [] };
      },
      async run() {
        if (sql.includes("INSERT INTO email_deliveries")) db.emailDeliveries.push(this.values);
        if (sql.includes("UPDATE meetings SET summary_status")) db.summaryStatuses.push(this.values);
        return { success: true };
      }
    };
  }
}

describe("summary workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps generated recaps ready without emailing meeting attendees by default", async () => {
    const db = new FakeD1();
    const send = vi.fn(async (message: unknown) => ({ id: `msg-${(message as { to: string }).to}` }));

    await generateAndSendSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        SESSION_SECRET: "session-secret",
        TRANSCRIPT_LINK_SECRET: "transcript-secret",
        SEND_EMAIL: { send }
      },
      "mtg_1"
    );

    expect(send).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toEqual([]);
    expect(db.summaryStatuses.map((values) => values[0])).toEqual(["generating", "ready"]);
  });

  it("can generate and store a recap without applying automatic recipient delivery", async () => {
    const db = new FakeD1({
      ...defaultSettings,
      email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: true }
    });
    const send = vi.fn(async (message: unknown) => ({ id: `msg-${(message as { to: string }).to}` }));

    const result = await generateAndStoreSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        SESSION_SECRET: "session-secret",
        TRANSCRIPT_LINK_SECRET: "transcript-secret",
        SEND_EMAIL: { send }
      },
      "mtg_1"
    );

    expect(result.meeting).toMatchObject({ id: "mtg_1", subject: "Project Sync" });
    expect(result.summary).toMatchObject({ summary: ["Summary ready."] });
    expect(result.excludedRecipients).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(db.emailDeliveries).toEqual([]);
    expect(db.summaryStatuses.map((values) => values[0])).toEqual(["generating", "ready"]);
  });

  it("sends recaps to organizer and allowed-domain attendees and records deliveries when automatic delivery is enabled", async () => {
    const db = new FakeD1({
      ...defaultSettings,
      email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: true }
    });
    const send = vi.fn(async (message: unknown) => ({ id: `msg-${(message as { to: string }).to}` }));

    await generateAndSendSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        SESSION_SECRET: "session-secret",
        TRANSCRIPT_LINK_SECRET: "transcript-secret",
        SEND_EMAIL: { send }
      },
      "mtg_1"
    );

    expect(send.mock.calls.map(([message]) => (message as { to: string }).to)).toEqual(["owner@wgs.bot", "alex@team.wgs.bot", "casey@partner.com", "no-show@wgs.bot"]);
    expect(db.emailDeliveries.map((values) => values[2])).toEqual(["owner@wgs.bot", "alex@team.wgs.bot", "casey@partner.com", "no-show@wgs.bot"]);
    expect(db.emailDeliveries.every((values) => values[4] === "sent")).toBe(true);
    expect(send.mock.calls[0][0]).toMatchObject({
      from: "WGS Notetaker <notetaker@wgs.bot>",
      text: expect.stringContaining("/api/artifacts/mtg_1/transcript.txt?token="),
      html: expect.stringContaining("Download Transcript")
    });
  });

  it("sends an uploaded transcript test recap only to the requested recipient", async () => {
    const db = new FakeD1({
      ...defaultSettings,
      email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: false }
    });
    const send = vi.fn(async (message: unknown) => ({ id: `msg-${(message as { to: string }).to}` }));

    const result = await generateAndSendSingleRecipientSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        TRANSCRIPT_LINK_SECRET: "transcript-secret",
        SEND_EMAIL: { send }
      },
      {
        meetingId: "mtg_1",
        recipientEmail: "reviewer@example.com",
        auditEmailType: "summary_test"
      }
    );

    expect(result).toMatchObject({ status: "sent", providerMessageId: "msg-reviewer@example.com" });
    expect(send.mock.calls.map(([message]) => (message as { to: string }).to)).toEqual(["reviewer@example.com"]);
    expect(db.emailDeliveries.map((values) => values[2])).toEqual(["reviewer@example.com"]);
    expect(db.summaryStatuses.map((values) => values[0])).toEqual(["generating", "ready", "sent"]);
  });

  it("uses the configured transcript link expiration when signing recap downloads", async () => {
    const db = new FakeD1({
      ...defaultSettings,
      email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: true },
      recap: {
        ...defaultSettings.recap,
        transcriptDownloadExpirationHours: 6
      }
    });
    const send = vi.fn(async (message: unknown) => ({ id: `msg-${(message as { to: string }).to}` }));
    const now = Date.now();

    await generateAndSendSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        SESSION_SECRET: "session-secret",
        TRANSCRIPT_LINK_SECRET: "transcript-secret",
        SEND_EMAIL: { send }
      },
      "mtg_1"
    );

    const text = send.mock.calls[0][0] as { text: string };
    const token = text.text.match(/token=([^)\s]+)/)?.[1];
    expect(token).toBeTruthy();
    const payload = await verifyTranscriptDownloadToken(decodeURIComponent(token!), "transcript-secret");

    expect(payload?.expiresAt).toBeGreaterThanOrEqual(now + 6 * 60 * 60 * 1000 - 1000);
    expect(payload?.expiresAt).toBeLessThanOrEqual(now + 6 * 60 * 60 * 1000 + 1000);
  });

  it("passes recap classification defaults into summary generation", async () => {
    const db = new FakeD1({
      ...defaultSettings,
      email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: true }
    });

    await generateAndSendSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        SESSION_SECRET: "session-secret",
        SEND_EMAIL: { send: vi.fn(async () => ({ id: "msg-1" })) }
      },
      "mtg_1"
    );

    expect(vi.mocked(summarizeTranscript).mock.calls[0][0]).toMatchObject({
      classificationEnabled: true,
      defaultTemplate: "auto",
      shortMeetingBriefRecapEnabled: true,
      shortMeetingDurationThresholdMinutes: 2,
      meetingEndTime: "2026-05-04T15:02:00.000Z",
      meetingDurationMinutes: 2,
      transcriptDurationMinutes: 1.3,
      speakerTurnCount: 2,
      wordCount: 2
    });
  });

  it("does not mint transcript links from the admin session secret", async () => {
    const db = new FakeD1({
      ...defaultSettings,
      email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: true }
    });
    const send = vi.fn(async (message: unknown) => ({ id: `msg-${(message as { to: string }).to}` }));

    await generateAndSendSummary(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          get: vi.fn(async () => ({ text: async () => "Alex: hello" })),
          put: vi.fn(async () => undefined)
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
        AI_API_KEY: "test-ai-key",
        SESSION_SECRET: "session-secret",
        SEND_EMAIL: { send }
      },
      "mtg_1"
    );

    expect((send.mock.calls[0][0] as { text: string }).text).not.toContain("/api/artifacts/mtg_1/transcript.txt?token=");
  });
});
