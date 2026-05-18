import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { app } from "../index";
import type { Env } from "../env";

class MemoryD1 {
  rows = new Map<string, string>();
  meetings: Record<string, unknown>[] = [];
  artifacts: Record<string, unknown>[] = [];
  summaries: Record<string, unknown>[] = [];
  auditLogs: unknown[][] = [];
  emailDeliveries: unknown[][] = [];
  summaryStatuses: unknown[][] = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM settings")) {
          const key = this.values[0] as string;
          const value = db.rows.get(key);
          return value ? ({ key, value, updated_at: new Date().toISOString() } as T) : null;
        }
        if (sql.includes("FROM meetings WHERE calendar_uid")) {
          return (db.meetings.find((meeting) => meeting.calendar_uid === this.values[0]) as T | undefined) ?? null;
        }
        if (sql.includes("FROM meetings WHERE id")) {
          return (db.meetings.find((meeting) => meeting.id === this.values[0]) as T | undefined) ?? null;
        }
        if (sql.includes("FROM artifacts")) {
          return null;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM artifacts")) {
          return { results: db.artifacts.filter((artifact) => artifact.meeting_id === this.values[0]) as T[] };
        }
        if (sql.includes("FROM attendees")) return { results: [] as T[] };
        if (sql.includes("FROM transcript_segments")) return { results: [] as T[] };
        return { results: [] as T[] };
      },
      async run() {
        if (sql.startsWith("INSERT OR REPLACE INTO settings")) {
          db.rows.set(this.values[0] as string, this.values[1] as string);
        }
        if (sql.includes("INSERT OR REPLACE INTO meetings")) {
          const meeting = {
            id: this.values[0],
            calendar_uid: this.values[1],
            subject: this.values[2],
            organizer_email: this.values[3],
            organizer_name: this.values[4],
            teams_join_url: this.values[5],
            start_time: this.values[6],
            end_time: this.values[7],
            status: this.values[8],
            transcript_status: this.values[14],
            summary_status: this.values[15]
          };
          db.meetings = db.meetings.filter((row) => row.id !== meeting.id);
          db.meetings.push(meeting);
        }
        if (sql.includes("UPDATE meetings SET summary_status")) {
          db.summaryStatuses.push(this.values);
          const meeting = db.meetings.find((row) => row.id === this.values[3]);
          if (meeting) {
            meeting.summary_status = this.values[0];
            if (this.values[1]) meeting.status = this.values[1];
          }
        }
        if (sql.includes("INSERT INTO artifacts")) {
          db.artifacts.push({
            id: this.values[0],
            meeting_id: this.values[1],
            type: this.values[2],
            r2_key: this.values[3],
            content_type: this.values[4],
            size_bytes: this.values[5],
            created_at: this.values[6],
            deleted_at: this.values[7]
          });
        }
        if (sql.includes("INSERT INTO summaries")) {
          db.summaries.push({
            id: this.values[0],
            meeting_id: this.values[1],
            r2_key: this.values[2],
            summary_json: this.values[3],
            model: this.values[4],
            created_at: this.values[5]
          });
        }
        if (sql.includes("INSERT INTO email_deliveries")) db.emailDeliveries.push(this.values);
        if (sql.includes("INSERT INTO audit_logs")) db.auditLogs.push(this.values);
        return { success: true };
      }
    };
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: new MemoryD1() as unknown as D1Database,
    ARTIFACTS: {} as R2Bucket,
    INVITE_QUEUE: { send: async () => undefined },
    SUMMARY_QUEUE: { send: async () => undefined },
  EMAIL_QUEUE: { send: async () => undefined },
    APP_BASE_URL: "https://minutesbot.example.com",
    API_BASE_URL: "https://minutesbot.example.com",
    ATTENDEE_API_BASE_URL: "https://attendee.example.com",
    DEFAULT_RECORDER_EMAIL: "notetaker@example.com",
    DEFAULT_SENDER_EMAIL: "notetaker@example.com",
    ENVIRONMENT: "test",
    SESSION_SECRET: "test-secret",
    TRANSCRIPT_LINK_SECRET: "transcript-secret",
    ...overrides
  };
}

async function post(path: string, testEnv: Env, body?: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    testEnv
  );
}

describe("admin test actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the dedicated Attendee webhook URL separately from the API base URL", async () => {
    const response = await app.request(
      "/api/admin/status",
      { headers: { authorization: "Bearer test-secret" } },
      env({
        API_BASE_URL: "https://minutesbot.example.com",
        ATTENDEE_WEBHOOK_BASE_URL: "https://minutesbot-webhook.wgsglobal.app"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      webhookUrl: "https://minutesbot-webhook.wgsglobal.app/api/webhooks/attendee"
    });
  });

  it("reports when the AI API key secret is not configured", async () => {
    const response = await post("/api/admin/test-ai", env());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "AI_API_KEY secret is not configured"
    });
  });

  it("tests the OpenAI-compatible AI provider without returning the secret", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const response = await post("/api/admin/test-ai", env({ AI_API_KEY: "sk-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "AI provider connection succeeded",
      provider: {
        type: defaultSettings.ai.provider,
        baseUrl: defaultSettings.ai.baseUrl,
        model: defaultSettings.ai.model
      }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].init?.headers).toMatchObject({ authorization: "Bearer sk-secret" });
  });

  it("rejects invalid sample recap email recipients", async () => {
    const missing = await post("/api/admin/send-test-summary-email", env(), {});
    const invalid = await post("/api/admin/send-test-summary-email", env(), { to: "not-an-email" });

    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      message: "Enter a valid recipient email address"
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      ok: false,
      message: "Enter a valid recipient email address"
    });
  });

  it("sends a rendered sample recap email to the specified recipient without exposing secrets", async () => {
    const sent: unknown[] = [];
    const testEnv = env({
      SEND_EMAIL: {
        send: vi.fn(async (message: unknown) => {
          sent.push(message);
          return { id: "provider-message-1" };
        })
      },
      SMTP_PASSWORD: "smtp-secret"
    });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        email: {
          ...defaultSettings.email,
          provider: "cloudflare-email-service",
          senderEmail: "recaps@wgs.bot"
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/send-test-summary-email", testEnv, { to: "Reviewer@Example.COM" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Sample recap email sent",
      recipient: "reviewer@example.com",
      status: "sent",
      providerMessageId: "provider-message-1"
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "WGS Notetaker <recaps@wgs.bot>",
      to: "reviewer@example.com",
      subject: "Meeting recap: Sample recap email"
    });
    expect(JSON.stringify(sent[0])).toContain("Generated by AI. Be sure to check for accuracy.");
    expect(JSON.stringify(sent[0])).toContain("Email Delivery Validation");
    expect(JSON.stringify(sent[0])).not.toContain("smtp-secret");
  });

  it("returns a provider failure when the sample recap email send throws", async () => {
    const testEnv = env({
      SEND_EMAIL: {
        send: vi.fn(async () => {
          throw new Error("provider unavailable");
        })
      }
    });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        email: {
          ...defaultSettings.email,
          provider: "cloudflare-email-service"
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/send-test-summary-email", testEnv, { to: "reviewer@example.com" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "provider unavailable"
    });
  });

  it("rejects invalid uploaded transcript recap test payloads", async () => {
    const missingRecipient = await post("/api/admin/test-uploaded-transcript-recap", env({ AI_API_KEY: "test-ai-key" }), {
      subject: "Old meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "owner@wgs.bot",
      transcriptText: "Alex: We reviewed the launch plan."
    });
    const missingTranscript = await post("/api/admin/test-uploaded-transcript-recap", env({ AI_API_KEY: "test-ai-key" }), {
      recipient: "reviewer@example.com",
      subject: "Old meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "owner@wgs.bot",
      transcriptText: " "
    });
    const tooLarge = await post("/api/admin/test-uploaded-transcript-recap", env({ AI_API_KEY: "test-ai-key" }), {
      recipient: "reviewer@example.com",
      subject: "Old meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "owner@wgs.bot",
      transcriptText: "a".repeat(1_000_001)
    });

    expect(missingRecipient.status).toBe(400);
    await expect(missingRecipient.json()).resolves.toEqual({ ok: false, message: "Enter a valid recipient email address" });
    expect(missingTranscript.status).toBe(400);
    await expect(missingTranscript.json()).resolves.toEqual({ ok: false, message: "Upload or paste a transcript to test recap generation" });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({ ok: false, message: "Transcript is too large to summarize automatically" });
  });

  it("requires an AI key before creating an uploaded transcript recap test meeting", async () => {
    const testEnv = env();

    const response = await post("/api/admin/test-uploaded-transcript-recap", testEnv, {
      recipient: "reviewer@example.com",
      subject: "Old meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "owner@wgs.bot",
      transcriptText: "Alex: We reviewed the launch plan."
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ ok: false, message: "AI_API_KEY secret is not configured" });
    expect((testEnv.DB as unknown as MemoryD1).meetings).toEqual([]);
  });

  it("creates a synthetic meeting, summarizes the uploaded transcript, and emails only the override recipient", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  meetingType: "general",
                  recapDepth: "standard",
                  summary: ["The uploaded transcript was summarized."],
                  decisions: [],
                  actionItems: [],
                  openQuestions: [],
                  risks: [],
                  followUps: [],
                  meetingNotes: [
                    {
                      heading: "Uploaded Transcript Review",
                      overview: "The team reviewed the launch plan.",
                      items: [{ title: "Launch plan", detail: "Alex confirmed the launch checklist is ready." }]
                    }
                  ],
                  followUpTasks: []
                })
              }
            }
          ]
        })
      )
    );
    const artifacts = new Map<string, string>();
    const testEnv = env({
      AI_API_KEY: "test-ai-key",
      SEND_EMAIL: {
        send: vi.fn(async (message: unknown) => {
          sent.push(message);
          return { id: "provider-message-1" };
        })
      },
      ARTIFACTS: {
        put: vi.fn(async (key: string, value: string) => {
          artifacts.set(key, value);
        }),
        get: vi.fn(async (key: string) => {
          const value = artifacts.get(key);
          return value ? { text: async () => value, size: new TextEncoder().encode(value).byteLength } : null;
        })
      } as unknown as R2Bucket
    });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        email: {
          ...defaultSettings.email,
          provider: "cloudflare-email-service",
          sendMeetingRecapsAutomatically: true
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/test-uploaded-transcript-recap", testEnv, {
      recipient: "Reviewer@Example.COM",
      subject: "Old Launch Meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "Owner@WGS.Bot",
      organizerName: "Owner",
      transcriptText: "Alex: We reviewed the launch plan.\nCasey: The checklist is ready."
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { meetingId?: string };
    expect(body).toMatchObject({
      ok: true,
      message: "Uploaded transcript recap generated and sent",
      recipient: "reviewer@example.com",
      status: "sent",
      providerMessageId: "provider-message-1"
    });
    expect(body.meetingId).toMatch(/^mtg_/);
    const db = testEnv.DB as unknown as MemoryD1;
    expect(db.meetings[0]).toMatchObject({
      calendar_uid: expect.stringMatching(/^test-recap-upload:/),
      subject: "Old Launch Meeting",
      organizer_email: "owner@wgs.bot",
      status: "SUMMARY_SENT",
      transcript_status: "complete",
      summary_status: "sent"
    });
    expect(db.artifacts.map((artifact) => artifact.type)).toEqual(["transcript_text", "transcript_json"]);
    expect(db.summaries).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "reviewer@example.com",
      subject: "Meeting recap: Old Launch Meeting"
    });
    expect(JSON.stringify(sent[0])).not.toContain("owner@wgs.bot");
  });

  it("keeps the generated uploaded transcript recap when override email delivery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  meetingType: "general",
                  recapDepth: "standard",
                  summary: ["Summary ready."],
                  decisions: [],
                  actionItems: [],
                  openQuestions: [],
                  risks: [],
                  followUps: [],
                  meetingNotes: [],
                  followUpTasks: []
                })
              }
            }
          ]
        })
      )
    );
    const artifacts = new Map<string, string>();
    const testEnv = env({
      AI_API_KEY: "test-ai-key",
      SEND_EMAIL: { send: vi.fn(async () => { throw new Error("provider unavailable"); }) },
      ARTIFACTS: {
        put: vi.fn(async (key: string, value: string) => {
          artifacts.set(key, value);
        }),
        get: vi.fn(async (key: string) => {
          const value = artifacts.get(key);
          return value ? { text: async () => value, size: new TextEncoder().encode(value).byteLength } : null;
        })
      } as unknown as R2Bucket
    });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({ ...defaultSettings, email: { ...defaultSettings.email, provider: "cloudflare-email-service" } }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/test-uploaded-transcript-recap", testEnv, {
      recipient: "reviewer@example.com",
      subject: "Old meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "owner@wgs.bot",
      transcriptText: "Alex: We reviewed the launch plan."
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ ok: false, message: "provider unavailable" });
    const db = testEnv.DB as unknown as MemoryD1;
    expect(db.summaries).toHaveLength(1);
    expect(db.summaryStatuses.map((values) => values[0])).toContain("ready");
  });

  it("calls Attendee when testing Attendee auth without returning the secret", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn(async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(url), init });
          if (String(url).endsWith("/minutesbot-preflight")) return new Response("not found", { status: 404 });
          return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/test", state: "ready" });
        })
    );

    const response = await post("/api/admin/test-attendee", env({ ATTENDEE_API_KEY: "attendee-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Attendee API connection succeeded",
      attendee: {
        baseUrl: defaultSettings.attendee.baseUrl
      }
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(`${defaultSettings.attendee.baseUrl}/api/v1/bots/minutesbot-preflight`);
    expect(requests[1].url).toBe(`${defaultSettings.attendee.baseUrl}/api/v1/bots/minutesbot-preflight`);
    expect(requests[1].init?.headers).toMatchObject({ authorization: "Token attendee-secret" });
  });

  it("returns a redacted Attendee auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] }))
        .mockResolvedValueOnce(new Response("nope attendee-secret", { status: 401 }))
    );

    const response = await post("/api/admin/test-attendee", env({ ATTENDEE_API_KEY: "attendee-secret" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "ATTENDEE_AUTH_FAILED: Attendee request failed with 401"
    });
  });

  it("returns Attendee health failures with missing runtime settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, runtime: "cloudflare-containers", missing: ["DATABASE_URL", "REDIS_URL"] }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const testEnv = env({ ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app", ATTENDEE_API_KEY: "attendee-secret" });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        attendee: {
          ...defaultSettings.attendee,
          baseUrl: "https://attendee.wgsglobal.app"
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/test-attendee", testEnv);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "ATTENDEE_UNHEALTHY: Attendee health check failed: missing DATABASE_URL, REDIS_URL"
    });
  });
});
