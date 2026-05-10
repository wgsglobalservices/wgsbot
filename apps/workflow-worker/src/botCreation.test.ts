import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { createMeetingBot } from "./botCreation";
import type { WorkflowEnv } from "./env";

class BotCreationD1 {
  meeting = {
    id: "mtg_1",
    calendar_uid: "teams-link-1",
    teams_join_url: "https://teams.microsoft.com/l/meetup-join/abc",
    status: "SCHEDULED"
  };
  settings = defaultSettings;
  statusUpdates: Array<{ status: string; latestError: string | null }> = [];
  auditLogs: Array<{ eventType: string; metadata: unknown }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM meetings")) return db.meeting as T;
        if (sql.includes("FROM settings")) {
          return { key: "app", value: JSON.stringify(db.settings), updated_at: new Date().toISOString() } as T;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("UPDATE meetings SET status")) {
          db.statusUpdates.push({ status: this.values[0] as string, latestError: this.values[1] as string | null });
        }
        if (sql.startsWith("INSERT INTO audit_logs")) {
          db.auditLogs.push({ eventType: this.values[2] as string, metadata: this.values[5] ? JSON.parse(this.values[5] as string) : null });
        }
        return { success: true };
      }
    };
  }
}

class BotImageR2 {
  constructor(private readonly image: Uint8Array) {}

  async get(key: string) {
    if (key !== "settings/attendee-bot-image.png") return null;
    return {
      arrayBuffer: async () => this.image.buffer.slice(this.image.byteOffset, this.image.byteOffset + this.image.byteLength)
    };
  }
}

function env(overrides: Partial<WorkflowEnv> = {}, db = new BotCreationD1()): WorkflowEnv {
  return {
    DB: db as unknown as D1Database,
    ARTIFACTS: {} as R2Bucket,
    INVITE_QUEUE: { send: vi.fn() },
    SUMMARY_QUEUE: { send: vi.fn() },
    EMAIL_QUEUE: { send: vi.fn() },
    BOT_API_BASE_URL: "https://meeting-bot.example.com",
    BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
    API_BASE_URL: "https://minutesbot.example.com",
    BOT_WEBHOOK_BASE_URL: "https://minutesbot-webhook.example.com",
    ...overrides
  };
}

describe("createMeetingBot failure handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds the uploaded bot image and configured Teams display name to meeting bot creation", async () => {
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        botName: "Meeting Assistant",
        botImage: {
          r2Key: "settings/attendee-bot-image.png",
          contentType: "image/png",
          fileName: "minutesbot.png",
          uploadedAt: "2026-05-06T12:00:00.000Z"
        }
      }
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/_ops/health")) return Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] });
        return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "joining" }, { status: 201 });
      })
    );

    await createMeetingBot(env({ ARTIFACTS: new BotImageR2(new Uint8Array([1, 2, 3])) as unknown as R2Bucket }, db), "mtg_1");

    const createRequest = requests.find((request) => request.url.endsWith("/api/v1/bots"));
    expect(JSON.parse(createRequest?.init?.body as string)).toMatchObject({
      bot_name: "Meeting Assistant",
      bot_image: {
        type: "image/png",
        data: "AQID"
      }
    });
  });

  it("creates meeting bots with MP3 recording upload to R2", async () => {
    const db = new BotCreationD1();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/_ops/health")) return Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] });
        return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "joining" }, { status: 201 });
      })
    );

    await createMeetingBot(env({}, db), "mtg_1");

    const createRequest = requests.find((request) => request.url.endsWith("/api/v1/bots"));
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest?.init?.body as string)).toMatchObject({
      meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
      bot_name: "minutesbot",
      bot_chat_message: {
        to: "everyone",
        message: "Hi, I'm minutesbot, an automated meeting notetaker. I record and transcribe this meeting so the team can receive a recap."
      },
      recording_settings: { format: "mp3" },
      external_media_storage_settings: {
        bucket_name: "minutesbot-artifacts",
        recording_file_name: "recordings/mtg_1/recording.mp3"
      },
      webhooks: [
        {
          url: "https://minutesbot-webhook.example.com/api/webhooks/bot"
        }
      ]
    });
  });

  it("stores a visible failure when the meeting bot runtime cannot be reached", async () => {
    const db = new BotCreationD1();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );

    await expect(createMeetingBot(env({}, db), "mtg_1")).rejects.toThrow("fetch failed");

    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "BOT_CREATE_FAILED: fetch failed"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({ eventType: "bot.fatal_error" });
  });

  it("stores a visible failure when the meeting bot runtime rejects bot creation", async () => {
    const db = new BotCreationD1();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] }))
        .mockResolvedValueOnce(new Response("bad auth", { status: 401 }))
    );

    await expect(createMeetingBot(env({}, db), "mtg_1")).rejects.toMatchObject({ code: "BOT_AUTH_FAILED" });

    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "BOT_AUTH_FAILED: Meeting bot request failed with 401"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({ eventType: "bot.fatal_error" });
  });

  it("stores a visible failure when meeting bot health reports missing runtime settings", async () => {
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        baseUrl: "https://meeting-bot.example.com"
      }
    };
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ ok: false, runtime: "meeting-bot-container", missing: ["TEAMS_RECORDER_PASSWORD", "ffmpeg"] }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      })
    );

    await expect(createMeetingBot(env({ BOT_API_BASE_URL: "https://meeting-bot.example.com" }, db), "mtg_1")).rejects.toMatchObject({
      code: "BOT_UNHEALTHY"
    });

    expect(requests).toEqual(["https://meeting-bot.example.com/_ops/health"]);
    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "BOT_UNHEALTHY: Meeting bot health check failed: missing TEAMS_RECORDER_PASSWORD, ffmpeg"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({
      eventType: "bot.fatal_error",
      metadata: { code: "BOT_UNHEALTHY" }
    });
  });
});
