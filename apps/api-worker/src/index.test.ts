import { describe, expect, it, vi } from "vitest";
import * as entrypoint from "./index";
import { app } from "./index";
import type { Env } from "./env";
import { createTranscriptDownloadToken, defaultSettings } from "@minutesbot/shared";

class FakeD1 {
  prepare() {
    return {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
      async run() {
        return { success: true };
      },
      async all() {
        return { results: [] };
      }
    };
  }
}

class MeetingsListD1 {
  attendeeListQueries = 0;

  prepare(sql: string) {
    const db = this;
    return {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
      async run() {
        return { success: true };
      },
      async all<T>() {
        if (/FROM attendees WHERE meeting_id = \?/i.test(sql)) {
          db.attendeeListQueries += 1;
          return { results: [] } as T;
        }
        if (sql.includes("FROM meetings")) {
          return {
            results: [
              {
                id: "mtg_1",
                subject: "Project Sync",
                organizer_email: "owner@wgs.bot",
                start_time: "2026-05-04T15:00:00.000Z",
                status: "SUMMARY_SENT",
                eligible_recipient_count: 2
              },
              {
                id: "mtg_2",
                subject: "Sales Review",
                organizer_email: "sales@wgs.bot",
                start_time: "2026-05-05T15:00:00.000Z",
                status: "WAITING_TO_CREATE_BOT",
                eligible_recipient_count: 1
              }
            ]
          } as T;
        }
        return { results: [] } as T;
      }
    };
  }
}

class ManualSummaryD1 {
  emailDeliveries: unknown[][] = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM meetings")) {
          return {
            id: "mtg_1",
            subject: "Project Sync",
            organizer_email: "owner@wgs.bot",
            organizer_name: "Owner",
            start_time: "2026-05-04T15:00:00.000Z"
          } as T;
        }
        if (sql.includes("FROM summaries")) {
          return {
            id: "sum_1",
            meeting_id: "mtg_1",
            summary_json: JSON.stringify({
              meetingType: "general",
              recapDepth: "standard",
              meetingNotes: [
                {
                  heading: "Project Updates",
                  overview: "The project recap is ready.",
                  items: [{ title: "Status", detail: "Alex reviewed the launch path." }]
                }
              ],
              followUpTasks: [],
              summary: [],
              decisions: [],
              actionItems: [],
              openQuestions: [],
              risks: [],
              followUps: []
            }),
            model: "gpt-4.1-mini",
            created_at: "2026-05-04T15:05:00.000Z"
          } as T;
        }
        if (sql.includes("FROM settings")) {
          return {
            key: "app",
            value: JSON.stringify({
              ...defaultSettings,
              email: {
                ...defaultSettings.email,
                provider: "cloudflare-email-service"
              }
            }),
            updated_at: "2026-05-04T00:00:00.000Z"
          } as T;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM attendees")) {
          return {
            results: [
              { email: "alex@wgs.bot", name: "Alex", summary_eligible: 1 },
              { email: "vendor@example.net", name: "Vendor", summary_eligible: 0 }
            ]
          } as T;
        }
        return { results: [] } as T;
      },
      async run() {
        if (sql.includes("INSERT INTO email_deliveries")) db.emailDeliveries.push(this.values);
        return { success: true };
      }
    };
  }
}

class DeleteMeetingD1 {
  runSql: string[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM meetings WHERE id")) {
          return {
            id: "mtg_1",
            subject: "Project Sync",
            organizer_email: "owner@wgs.bot",
            start_time: "2026-05-04T15:00:00.000Z",
            status: "SUMMARY_SENT",
            created_at: "2026-05-04T15:00:00.000Z",
            updated_at: "2026-05-04T15:05:00.000Z"
          } as T;
        }
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM artifacts")) {
          return {
            results: [
              { id: "art_1", meeting_id: "mtg_1", type: "transcript_text", r2_key: "transcripts/mtg_1/transcript.txt", created_at: "2026-05-04T15:05:00.000Z", deleted_at: null },
              { id: "art_2", meeting_id: "mtg_1", type: "summary_json", r2_key: "summaries/mtg_1/summary.json", created_at: "2026-05-04T15:06:00.000Z", deleted_at: "2026-05-04T15:07:00.000Z" }
            ]
          } as T;
        }
        return { results: [] } as T;
      },
      async run() {
        db.runSql.push(sql);
        return { success: true };
      }
    };
  }
}

describe("api worker", () => {
  it("returns health", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("requires auth configuration for protected admin routes", async () => {
    const response = await app.request("/api/settings");
    expect(response.status).toBe(503);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "AUTH_NOT_CONFIGURED",
        message: "Configure SESSION_SECRET before exposing admin routes."
      }
    });
  });

  it("exports the configured meeting workflow entrypoint", () => {
    expect(entrypoint).toHaveProperty("MeetingWorkflow");
  });

  it("serves admin UI assets only from APP_BASE_URL host", async () => {
    const assetsFetch = vi.fn(async () => new Response("<html>admin</html>", { headers: { "content-type": "text/html" } }));
    const env = {
      APP_BASE_URL: "https://minutesbot-admin.wgsglobal.app",
      ASSETS: { fetch: assetsFetch }
    } as unknown as Env;

    const adminResponse = await entrypoint.handleFetch(new Request("https://minutesbot-admin.wgsglobal.app/"), env);
    const apiHostResponse = await entrypoint.handleFetch(new Request("https://minutesbot-api.wgsglobal.app/"), env);
    const webhookHostResponse = await entrypoint.handleFetch(new Request("https://minutesbot-webhook.wgsglobal.app/"), env);

    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.text()).toBe("<html>admin</html>");
    expect(apiHostResponse.status).toBe(404);
    expect(webhookHostResponse.status).toBe(404);
    expect(assetsFetch).toHaveBeenCalledOnce();
  });

  it("still routes API requests on non-admin hosts through the Worker", async () => {
    const response = await entrypoint.handleFetch(
      new Request("https://minutesbot-api.wgsglobal.app/api/health"),
      {
        APP_BASE_URL: "https://minutesbot-admin.wgsglobal.app"
      } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("blocks protected admin API routes on non-admin hosts", async () => {
    const env = {
      APP_BASE_URL: "https://minutesbot-admin.wgsglobal.app"
    } as unknown as Env;

    const blocked = await entrypoint.handleFetch(
      new Request("https://minutesbot-api.wgsglobal.app/api/settings"),
      env
    );
    const allowed = await entrypoint.handleFetch(new Request("https://minutesbot-admin.wgsglobal.app/api/settings"), env);

    expect(blocked.status).toBe(404);
    expect(allowed.status).toBe(503);
    await expect(allowed.json()).resolves.toMatchObject({ error: { code: "AUTH_NOT_CONFIGURED" } });
  });

  it("queues manual transcript fetches as R2 recording processing requests", async () => {
    const send = vi.fn(async () => undefined);
    const response = await app.request(
      "/api/meetings/mtg_1/fetch-transcript",
      { method: "POST", headers: { authorization: "Bearer test-secret" } },
      {
        DB: new FakeD1() as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ type: "fetch_transcript", meetingId: "mtg_1" });
  });

  it("queues manual bot retries with a force flag", async () => {
    const send = vi.fn(async () => undefined);
    const response = await app.request(
      "/api/meetings/mtg_1/retry-bot",
      { method: "POST", headers: { authorization: "Bearer test-secret" } },
      {
        DB: new FakeD1() as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ type: "create_bot", meetingId: "mtg_1", force: true });
  });

  it("lists meetings with eligible recipient counts without per-meeting attendee queries", async () => {
    const db = new MeetingsListD1();
    const response = await app.request(
      "/api/meetings",
      { headers: { authorization: "Bearer test-secret" } },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      meetings: [
        { id: "mtg_1", eligible_recipient_count: 2 },
        { id: "mtg_2", eligible_recipient_count: 1 }
      ]
    });
    expect(db.attendeeListQueries).toBe(0);
  });

  it("deletes a meeting from history and removes active artifact objects", async () => {
    const db = new DeleteMeetingD1();
    const deleteObject = vi.fn(async () => undefined);
    const response = await app.request(
      "/api/meetings/mtg_1",
      { method: "DELETE", headers: { authorization: "Bearer test-secret" } },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: { delete: deleteObject } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deleted: true, artifactsDeleted: 1 });
    expect(deleteObject).toHaveBeenCalledWith("transcripts/mtg_1/transcript.txt");
    expect(db.runSql).toContain("DELETE FROM meetings WHERE id = ?");
    expect(db.runSql).toContain("INSERT INTO audit_logs (id, actor_email, event_type, resource_type, resource_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  });

  it("sends an existing meeting recap to one selected meeting email", async () => {
    const db = new ManualSummaryD1();
    const send = vi.fn(async () => ({ id: "manual-message-1" }));
    const response = await app.request(
      "/api/meetings/mtg_1/send-summary-email",
      {
        method: "POST",
        headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
        body: JSON.stringify({ to: "Alex@WGS.Bot" })
      },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SEND_EMAIL: { send },
        APP_BASE_URL: "https://minutesbot.example.com",
        API_BASE_URL: "https://minutesbot.example.com",
        ATTENDEE_API_BASE_URL: "https://attendee.example.com",
        DEFAULT_RECORDER_EMAIL: "notetaker@example.com",
        DEFAULT_SENDER_EMAIL: "notetaker@example.com",
        ENVIRONMENT: "test",
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Meeting recap email sent",
      recipient: "alex@wgs.bot",
      status: "sent",
      providerMessageId: "manual-message-1"
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: "WGS Notetaker <notetaker@wgs.bot>",
      to: "alex@wgs.bot",
      subject: "Meeting recap: Project Sync"
    }));
    expect(db.emailDeliveries.map((values) => values[2])).toEqual(["alex@wgs.bot"]);
  });

  it("rejects manual recap sends to addresses that are not on the meeting", async () => {
    const response = await app.request(
      "/api/meetings/mtg_1/send-summary-email",
      {
        method: "POST",
        headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
        body: JSON.stringify({ to: "outside@example.com" })
      },
      {
        DB: new ManualSummaryD1() as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SEND_EMAIL: { send: vi.fn() },
        APP_BASE_URL: "https://minutesbot.example.com",
        API_BASE_URL: "https://minutesbot.example.com",
        ATTENDEE_API_BASE_URL: "https://attendee.example.com",
        DEFAULT_RECORDER_EMAIL: "notetaker@example.com",
        DEFAULT_SENDER_EMAIL: "notetaker@example.com",
        ENVIRONMENT: "test",
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "RECIPIENT_NOT_ON_MEETING",
        message: "Choose the organizer or an attendee on this meeting."
      }
    });
  });

  it("downloads raw transcript text with a valid signed token", async () => {
    const token = await createTranscriptDownloadToken({ meetingId: "mtg_1", artifactType: "transcript_text", expiresAt: Date.now() + 60_000 }, "download-secret");
    const response = await app.request(
      `/api/artifacts/mtg_1/transcript.txt?token=${encodeURIComponent(token)}`,
      {},
      {
        DB: artifactDb() as unknown as D1Database,
        ARTIFACTS: { get: vi.fn(async () => ({ text: async () => "Alex: hello <raw>" })) } as unknown as R2Bucket,
        SESSION_SECRET: "test-secret",
        TRANSCRIPT_LINK_SECRET: "download-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toBe("Alex: hello <raw>");
  });

  it("rejects raw transcript downloads with invalid or expired tokens", async () => {
    const expired = await createTranscriptDownloadToken({ meetingId: "mtg_1", artifactType: "transcript_text", expiresAt: Date.now() - 1 }, "download-secret");
    const invalid = await app.request("/api/artifacts/mtg_1/transcript.txt?token=bad", {}, { DB: artifactDb() as unknown as D1Database, ARTIFACTS: {} as R2Bucket, SESSION_SECRET: "test-secret", TRANSCRIPT_LINK_SECRET: "download-secret" });
    const expiredResponse = await app.request(`/api/artifacts/mtg_1/transcript.txt?token=${encodeURIComponent(expired)}`, {}, { DB: artifactDb() as unknown as D1Database, ARTIFACTS: {} as R2Bucket, SESSION_SECRET: "test-secret", TRANSCRIPT_LINK_SECRET: "download-secret" });

    expect(invalid.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
  });

  it("handles inbound email on the deployed worker entrypoint", async () => {
    const raw = `From: Alice <alice@wgs.bot>
To: Alice <alice@wgs.bot>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-api-email
SUMMARY:API Entrypoint Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`;
    const queueInvite = vi.fn(async () => undefined);
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);

    await entrypoint.default.email(
      {
        from: "alice@wgs.bot",
        to: "notetaker@wgs.bot",
        raw: new Response(raw).body!,
        setReject: vi.fn()
      },
      {
        DB: new FakeD1() as unknown as D1Database,
        ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
        INVITE_QUEUE: { send: queueInvite }
      },
      { waitUntil } as unknown as ExecutionContext
    );

    await waitUntil.mock.calls[0][0];
    expect(queueInvite).toHaveBeenCalledOnce();
  });
});

function artifactDb() {
  return {
    prepare() {
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: [{ type: "transcript_text", r2_key: "transcripts/mtg_1/transcript.txt", deleted_at: null }] };
        }
      };
    }
  };
}
