import { describe, expect, it, vi } from "vitest";
import * as entrypoint from "./index";
import { app } from "./index";
import type { Env } from "./env";
import { createTranscriptDownloadToken } from "@minutesbot/shared";

class FakeD1 {
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

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

class MeetingDetailD1 {
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind() {
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings WHERE id")) {
          return {
            id: "mtg_1",
            calendar_uid: "teams-link-1",
            subject: "Failed bot",
            status: "BOT_FATAL_ERROR",
            latest_error: null,
            transcript_status: "not_started",
            summary_status: "not_started",
            created_at: "2026-05-10T03:26:00.000Z",
            updated_at: "2026-05-10T03:26:00.000Z"
          };
        }
        return null;
      },
      async run() {
        return { success: true };
      },
      async all() {
        if (sql.includes("FROM attendee_webhook_events")) {
          return {
            results: [
              {
                id: "wh_1",
                meeting_id: "mtg_1",
                payload: JSON.stringify({
                  data: {
                    event_type: "fatal_error",
                    latest_error: "Teams pre-join screen did not show a Join now button"
                  }
                }),
                created_at: "2026-05-10T03:26:22.959Z"
              }
            ]
          };
        }
        return { results: [] };
      }
    };
  }
}

class RetriedMeetingDetailD1 {
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string) {
    return {
      bind() {
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings WHERE id")) {
          return {
            id: "mtg_1",
            calendar_uid: "teams-link-1",
            subject: "Retried bot",
            status: "BOT_JOINING",
            latest_error: null,
            attendee_bot_id: "bot_new",
            attendee_bot_state: "joining",
            transcript_status: "not_started",
            summary_status: "not_started",
            created_at: "2026-05-10T03:26:00.000Z",
            updated_at: "2026-05-10T03:30:00.000Z"
          };
        }
        return null;
      },
      async run() {
        return { success: true };
      },
      async all() {
        if (sql.includes("FROM attendee_webhook_events")) {
          return {
            results: [
              {
                id: "wh_new",
                meeting_id: "mtg_1",
                attendee_bot_id: "bot_new",
                event_type: "state_change",
                payload: JSON.stringify({ data: { event_type: "state_change", new_state: "joining" } }),
                created_at: "2026-05-10T03:30:00.000Z"
              },
              {
                id: "wh_old",
                meeting_id: "mtg_1",
                attendee_bot_id: "bot_old",
                event_type: "fatal_error",
                payload: JSON.stringify({
                  data: {
                    event_type: "fatal_error",
                    latest_error: "Teams pre-join screen did not show a Join now button"
                  }
                }),
                created_at: "2026-05-10T03:26:22.959Z"
              }
            ]
          };
        }
        return { results: [] };
      }
    };
  }
}

class ActiveBotMeetingD1 {
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  updates: unknown[][] = [];
  audits: Array<{ eventType: string; metadata: string | null }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings WHERE id")) {
          return {
            id: this.values[0],
            calendar_uid: "teams-link-1",
            subject: "Active recording",
            status: "BOT_RECORDING",
            attendee_bot_id: "bot_active",
            attendee_bot_state: "recording",
            attendee_transcription_state: "pending",
            attendee_recording_state: "recording",
            latest_error: null,
            transcript_status: "not_started",
            summary_status: "not_started",
            created_at: "2026-05-10T03:26:00.000Z",
            updated_at: "2026-05-10T03:26:00.000Z"
          };
        }
        return null;
      },
      async run() {
        if (sql.includes("UPDATE meetings")) db.updates.push(this.values);
        if (sql.includes("INSERT INTO audit_logs")) {
          db.audits.push({ eventType: String(this.values[2]), metadata: this.values[5] == null ? null : String(this.values[5]) });
        }
        return { success: true };
      },
      async all() {
        return { results: [] };
      }
    };
  }
}

class DeleteMeetingD1 {
  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  deletedTables: string[] = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings WHERE id")) {
          return {
            id: this.values[0],
            subject: "Old meeting",
            status: "FAILED",
            created_at: "2026-05-10T03:26:00.000Z",
            updated_at: "2026-05-10T03:26:00.000Z"
          };
        }
        return null;
      },
      async run() {
        const match = sql.match(/^DELETE FROM (\w+)/);
        if (match?.[1]) db.deletedTables.push(match[1]);
        return { success: true };
      },
      async all() {
        if (sql.includes("FROM artifacts")) {
          return {
            results: [
              { id: "art_1", r2_key: "recordings/mtg_1/recording.mp3", deleted_at: null },
              { id: "art_2", r2_key: "transcripts/mtg_1/old.txt", deleted_at: "2026-05-10T03:30:00.000Z" }
            ]
          };
        }
        if (sql.includes("FROM summaries")) {
          return {
            results: [
              { r2_key: "summaries/mtg_1/summary.json" },
              { r2_key: "recordings/mtg_1/recording.mp3" }
            ]
          };
        }
        return { results: [] };
      }
    };
  }
}

describe("api worker", () => {
  it("returns health", async () => {
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("requires auth configuration for protected admin routes", async () => {
    const response = await app.request("/api/settings");
    expect(response.status).toBe(503);
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
      APP_BASE_URL: "https://minutesbot-admin.example.com",
      ASSETS: { fetch: assetsFetch }
    } as unknown as Env;

    const adminResponse = await entrypoint.handleFetch(new Request("https://minutesbot-admin.example.com/"), env);
    const apiHostResponse = await entrypoint.handleFetch(new Request("https://minutesbot-api.example.com/"), env);
    const webhookHostResponse = await entrypoint.handleFetch(new Request("https://minutesbot-webhook.example.com/"), env);

    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.text()).toBe("<html>admin</html>");
    expect(apiHostResponse.status).toBe(404);
    expect(webhookHostResponse.status).toBe(404);
    expect(assetsFetch).toHaveBeenCalledOnce();
  });

  it("requires Cloudflare Access JWTs before serving admin UI assets when Access is configured", async () => {
    const assetsFetch = vi.fn(async () => new Response("<html>admin</html>", { headers: { "content-type": "text/html" } }));
    const env = {
      APP_BASE_URL: "https://app.minutes.bot",
      CLOUDFLARE_ACCESS_AUD: "13f67694a98579897f6175043bb595df17afdfd5129d44c33e8b937b5576ae71",
      CLOUDFLARE_ACCESS_JWKS_URL: "https://esau.cloudflareaccess.com/cdn-cgi/access/certs",
      ASSETS: { fetch: assetsFetch }
    } as unknown as Env;

    const response = await entrypoint.handleFetch(new Request("https://app.minutes.bot/"), env);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ACCESS_JWT_MISSING" } });
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("still routes API requests on non-admin hosts through the Worker", async () => {
    const response = await entrypoint.handleFetch(
      new Request("https://minutesbot-api.example.com/api/health"),
      {
        APP_BASE_URL: "https://minutesbot-admin.example.com"
      } as unknown as Env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("blocks protected admin API routes on non-admin hosts", async () => {
    const env = {
      APP_BASE_URL: "https://minutesbot-admin.example.com"
    } as unknown as Env;

    const blocked = await entrypoint.handleFetch(
      new Request("https://minutesbot-api.example.com/api/settings"),
      env
    );
    const allowed = await entrypoint.handleFetch(new Request("https://minutesbot-admin.example.com/api/settings"), env);

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

  it("force-ends an active meeting bot recording through the managed runtime", async () => {
    const db = new ActiveBotMeetingD1();
    const runtimeFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://meeting-api.minutes.bot/api/v1/bots/bot_active/cancel");
      return Response.json({
        id: "bot_active",
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        state: "cancelling",
        recording_state: "recording",
        transcription_state: "pending"
      });
    });

    const response = await app.request(
      "/api/meetings/mtg_1/force-end-recording",
      { method: "POST", headers: { authorization: "Bearer test-secret" } },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RUNTIME: { fetch: runtimeFetch } as unknown as Fetcher,
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      bot: { id: "bot_active", state: "cancelling" }
    });
    expect(runtimeFetch).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/api/v1/bots/bot_active/cancel",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer managed-token" })
      })
    );
    expect(db.updates.at(-1)).toEqual(expect.arrayContaining(["bot_active", "cancelling", "pending", "recording", "BOT_LEAVING"]));
    expect(db.audits.map((audit) => audit.eventType)).toEqual(["bot.cancel_requested", "bot.cancel_requested"]);
    expect(db.audits[0]?.metadata).toContain("force_end_recording");
  });

  it("stores BOT_ENDED when force-end returns an ended runtime bot", async () => {
    const db = new ActiveBotMeetingD1();
    const runtimeFetch = vi.fn(async () =>
      Response.json({
        id: "bot_active",
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        state: "ended",
        recording_state: "complete",
        transcription_state: "complete"
      })
    );

    const response = await app.request(
      "/api/meetings/mtg_1/force-end-recording",
      { method: "POST", headers: { authorization: "Bearer test-secret" } },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RUNTIME: { fetch: runtimeFetch } as unknown as Fetcher,
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(db.updates.at(-1)).toEqual(expect.arrayContaining(["bot_active", "ended", "complete", "complete", "BOT_ENDED"]));
    expect(db.audits.map((audit) => audit.eventType)).toEqual(["bot.cancel_requested", "bot.ended"]);
  });

  it("does not map force-end runtime cancelled responses to meeting CANCELLED", async () => {
    const db = new ActiveBotMeetingD1();
    const runtimeFetch = vi.fn(async () =>
      Response.json({
        id: "bot_active",
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        state: "cancelled",
        recording_state: "cancelled",
        transcription_state: "failed"
      })
    );

    const response = await app.request(
      "/api/meetings/mtg_1/force-end-recording",
      { method: "POST", headers: { authorization: "Bearer test-secret" } },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RUNTIME: { fetch: runtimeFetch } as unknown as Fetcher,
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(db.updates.at(-1)).toEqual(expect.arrayContaining(["bot_active", "cancelled", "failed", "cancelled", "BOT_LEAVING"]));
    expect(db.updates.flat()).not.toContain("CANCELLED");
    expect(db.audits.map((audit) => audit.eventType)).not.toContain("bot.cancelled");
  });

  it("removes a meeting from history and deletes associated R2 objects", async () => {
    const db = new DeleteMeetingD1();
    const deletedObjects: string[] = [];
    const response = await app.request(
      "/api/meetings/mtg_1",
      { method: "DELETE", headers: { authorization: "Bearer test-secret" } },
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {
          delete: vi.fn(async (key: string) => {
            deletedObjects.push(key);
          })
        } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, objectsDeleted: 2 });
    expect(deletedObjects).toEqual(["recordings/mtg_1/recording.mp3", "summaries/mtg_1/summary.json"]);
    expect(db.deletedTables).toEqual([
      "attendees",
      "attendee_webhook_events",
      "transcript_segments",
      "artifacts",
      "email_deliveries",
      "summaries",
      "meetings"
    ]);
  });

  it("derives meeting detail latest_error from fatal bot webhook payloads", async () => {
    const response = await app.request(
      "/api/meetings/mtg_1",
      { headers: { authorization: "Bearer test-secret" } },
      {
        DB: new MeetingDetailD1() as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      meeting: {
        latest_error: "Teams pre-join screen did not show a Join now button"
      }
    });
  });

  it("does not show stale fatal webhook errors after a bot retry starts joining", async () => {
    const response = await app.request(
      "/api/meetings/mtg_1",
      { headers: { authorization: "Bearer test-secret" } },
      {
        DB: new RetriedMeetingDetailD1() as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      meeting: {
        status: "BOT_JOINING",
        latest_error: null
      }
    });
  });

  it("downloads raw transcript text with a valid signed token", async () => {
    const token = await createTranscriptDownloadToken({ meetingId: "mtg_1", artifactType: "transcript_text", expiresAt: Date.now() + 60_000 }, "test-secret");
    const response = await app.request(
      `/api/artifacts/mtg_1/transcript.txt?token=${encodeURIComponent(token)}`,
      {},
      {
        DB: artifactDb() as unknown as D1Database,
        ARTIFACTS: { get: vi.fn(async () => ({ text: async () => "Alex: hello <raw>" })) } as unknown as R2Bucket,
        SESSION_SECRET: "test-secret"
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(await response.text()).toBe("Alex: hello <raw>");
  });

  it("rejects raw transcript downloads with invalid or expired tokens", async () => {
    const expired = await createTranscriptDownloadToken({ meetingId: "mtg_1", artifactType: "transcript_text", expiresAt: Date.now() - 1 }, "test-secret");
    const invalid = await app.request("/api/artifacts/mtg_1/transcript.txt?token=bad", {}, { DB: artifactDb() as unknown as D1Database, ARTIFACTS: {} as R2Bucket, SESSION_SECRET: "test-secret" });
    const expiredResponse = await app.request(`/api/artifacts/mtg_1/transcript.txt?token=${encodeURIComponent(expired)}`, {}, { DB: artifactDb() as unknown as D1Database, ARTIFACTS: {} as R2Bucket, SESSION_SECRET: "test-secret" });

    expect(invalid.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
  });

  it("handles inbound email on the deployed worker entrypoint", async () => {
    const raw = `From: Alice <alice@company.com>
To: Alice <alice@company.com>

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test-api-email
SUMMARY:API Entrypoint Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@company.com
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@company.com
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`;
    const queueInvite = vi.fn(async () => undefined);
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);

    await entrypoint.default.email(
      {
        from: "alice@company.com",
        to: "notetaker@minutes.bot",
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
