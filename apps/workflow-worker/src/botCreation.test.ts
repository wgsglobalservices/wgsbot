import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { createMeetingBot, handleCreateBotQueueMessage, queueDueBotCreations } from "./botCreation";
import type { WorkflowEnv } from "./env";

class BotCreationD1 {
  meeting = {
    id: "mtg_1",
    calendar_uid: "teams-link-1",
    teams_join_url: "https://teams.microsoft.com/l/meetup-join/abc" as string | null,
    start_time: "2026-05-18T15:00:00.000Z",
    status: "SCHEDULED",
    attendee_bot_id: null as string | null
  };
  settings = defaultSettings;
  statusUpdates: Array<{ status: string; latestError: string | null }> = [];
  auditLogs: Array<{ eventType: string; metadata: unknown }> = [];
  dueMeetings: Array<{ id: string }> = [];
  dueCutoffIso: string | null = null;
  claims = 0;

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
      async all<T>() {
        if (sql.includes("FROM meetings")) {
          db.dueCutoffIso = this.values[0] as string;
          return { results: db.dueMeetings as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.startsWith("UPDATE meetings SET status")) {
          db.statusUpdates.push({ status: this.values[0] as string, latestError: this.values[1] as string | null });
        }
        if (sql.includes("WHERE id = ?") && sql.includes("attendee_bot_id IS NULL") && sql.includes("status IN")) {
          db.claims += 1;
          db.statusUpdates.push({ status: this.values[0] as string, latestError: this.values[1] as string | null });
          const claimable = ["SCHEDULED", "WAITING_TO_CREATE_BOT", "FAILED"].includes(db.meeting.status);
          if (claimable) db.meeting.status = this.values[0] as string;
          return { success: true, meta: { changes: "attendee_bot_id" in db.meeting && db.meeting.attendee_bot_id ? 0 : claimable ? 1 : 0 } };
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
    ATTENDEE_API_BASE_URL: "https://attendee.example.com",
    ATTENDEE_API_KEY: "attendee-secret",
    ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME: "minutesbot-artifacts",
    API_BASE_URL: "https://minutesbot.example.com",
    ATTENDEE_WEBHOOK_BASE_URL: "https://minutesbot-webhook.wgsglobal.app",
    ...overrides
  };
}

describe("createMeetingBot failure handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds the uploaded bot image and configured Teams display name to Attendee bot creation", async () => {
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        botName: "WGS Meeting Assistant",
        botImage: {
          r2Key: "settings/attendee-bot-image.png",
          contentType: "image/png",
          fileName: "wgsbot.png",
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
      bot_name: "WGS Meeting Assistant",
      bot_image: {
        type: "image/png",
        data: "AQID"
      }
    });
  });

  it("creates Attendee bots with MP3 recording upload to R2", async () => {
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
        message: "Hi, I'm minutesbot, an automated WGS meeting notetaker. I record and transcribe this meeting so the team can receive a recap."
      },
      recording_settings: { format: "mp3" },
      external_media_storage_settings: {
        bucket_name: "minutesbot-artifacts",
        recording_file_name: "recordings/mtg_1/recording.mp3"
      },
      webhooks: [
        {
          url: "https://minutesbot-webhook.wgsglobal.app/api/webhooks/attendee"
        }
      ]
    });
  });

  it("passes configured Attendee payload overrides without replacing core join fields", async () => {
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        botPayloadOverridesJson: JSON.stringify({
          meeting_url: "https://teams.microsoft.com/l/meetup-join/override",
          teams_settings: { use_login: true }
        })
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

    await createMeetingBot(env({}, db), "mtg_1");

    const createRequest = requests.find((request) => request.url.endsWith("/api/v1/bots"));
    expect(JSON.parse(createRequest?.init?.body as string)).toMatchObject({
      meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
      teams_settings: { use_login: true }
    });
  });

  it("stores a visible failure when ATTENDEE_API_KEY is missing", async () => {
    const db = new BotCreationD1();

    await expect(createMeetingBot(env({ ATTENDEE_API_KEY: undefined }, db), "mtg_1")).rejects.toMatchObject({
      code: "ATTENDEE_API_KEY_MISSING"
    });

    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "ATTENDEE_API_KEY_MISSING: ATTENDEE_API_KEY secret is not configured"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({ eventType: "bot.fatal_error" });
  });

  it("stores a visible failure without calling Attendee when the Teams join URL is missing", async () => {
    const db = new BotCreationD1();
    db.meeting.teams_join_url = null;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(createMeetingBot(env({}, db), "mtg_1")).rejects.toMatchObject({
      code: "MEETING_JOIN_URL_MISSING"
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "MEETING_JOIN_URL_MISSING: Meeting is missing a Teams join URL"
    });
  });

  it("stores a visible failure without calling Attendee when payload overrides are invalid", async () => {
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        botPayloadOverridesJson: "{bad-json"
      }
    };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(createMeetingBot(env({}, db), "mtg_1")).rejects.toMatchObject({
      code: "ATTENDEE_BOT_PAYLOAD_OVERRIDES_INVALID"
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "ATTENDEE_BOT_PAYLOAD_OVERRIDES_INVALID: Attendee bot payload overrides must be valid JSON"
    });
  });

  it("stores a visible failure when Attendee cannot be reached", async () => {
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
      latestError: "ATTENDEE_CREATE_FAILED: fetch failed"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({ eventType: "bot.fatal_error" });
  });

  it("stores a visible failure when Attendee rejects bot creation", async () => {
    const db = new BotCreationD1();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] }))
        .mockResolvedValueOnce(new Response("bad auth", { status: 401 }))
    );

    await expect(createMeetingBot(env({}, db), "mtg_1")).rejects.toMatchObject({ code: "ATTENDEE_AUTH_FAILED" });

    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "ATTENDEE_AUTH_FAILED: Attendee request failed with 401"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({ eventType: "bot.fatal_error" });
  });

  it("stores a visible failure when Attendee health reports missing runtime settings", async () => {
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        baseUrl: "https://attendee.wgsglobal.app"
      }
    };
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response(JSON.stringify({ ok: false, runtime: "cloudflare-containers", missing: ["DATABASE_URL", "REDIS_URL"] }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      })
    );

    await expect(createMeetingBot(env({ ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app" }, db), "mtg_1")).rejects.toMatchObject({
      code: "ATTENDEE_UNHEALTHY"
    });

    expect(requests).toEqual(["https://attendee.wgsglobal.app/_ops/health"]);
    expect(db.statusUpdates.at(-1)).toEqual({
      status: "FAILED",
      latestError: "ATTENDEE_UNHEALTHY: Attendee health check failed: missing DATABASE_URL, REDIS_URL"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({
      eventType: "bot.fatal_error",
      metadata: { code: "ATTENDEE_UNHEALTHY" }
    });
  });
});

describe("bot creation scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits until the actual start time for future meetings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:30:00.000Z"));
    const db = new BotCreationD1();
    db.meeting.start_time = "2026-05-18T15:00:00.000Z";
    db.settings = {
      ...defaultSettings,
      attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
    };
    const queueSend = vi.fn(async () => undefined);

    await handleCreateBotQueueMessage(env({ INVITE_QUEUE: { send: queueSend } }, db), "mtg_1");

    expect(queueSend).toHaveBeenCalledWith({ type: "create_bot", meetingId: "mtg_1" }, { delaySeconds: 1800 });
    expect(db.statusUpdates.at(-1)).toEqual({ status: "WAITING_TO_CREATE_BOT", latestError: null });
  });

  it("does not create the bot before the actual start time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:56:00.000Z"));
    const db = new BotCreationD1();
    db.meeting.start_time = "2026-05-18T15:00:00.000Z";
    db.settings = {
      ...defaultSettings,
      attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
    };
    const queueSend = vi.fn(async () => undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await handleCreateBotQueueMessage(env({ INVITE_QUEUE: { send: queueSend } }, db), "mtg_1");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith({ type: "create_bot", meetingId: "mtg_1" }, { delaySeconds: 240 });
    expect(db.statusUpdates.at(-1)).toEqual({ status: "WAITING_TO_CREATE_BOT", latestError: null });
  });

  it("creates the bot immediately when the invite arrives after the meeting started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T15:01:00.000Z"));
    const db = new BotCreationD1();
    db.meeting.start_time = "2026-05-18T15:00:00.000Z";
    db.settings = {
      ...defaultSettings,
      attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] }))
        .mockResolvedValueOnce(Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "joining" }, { status: 201 }))
    );

    await handleCreateBotQueueMessage(env({}, db), "mtg_1");

    expect(db.auditLogs.some((log) => log.eventType === "bot.created")).toBe(true);
  });

  it("honors forced bot creation for manual retries before the scheduled join time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:30:00.000Z"));
    const db = new BotCreationD1();
    db.meeting.start_time = "2026-05-18T15:00:00.000Z";
    db.settings = {
      ...defaultSettings,
      attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] }))
        .mockResolvedValueOnce(Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "joining" }, { status: 201 }))
    );

    await handleCreateBotQueueMessage(env({}, db), "mtg_1", { force: true });

    expect(db.auditLogs.some((log) => log.eventType === "bot.created")).toBe(true);
  });

  it("queues meetings due by actual start time from the scheduled worker scan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T14:55:00.000Z"));
    const db = new BotCreationD1();
    db.settings = {
      ...defaultSettings,
      attendee: { ...defaultSettings.attendee, createBotMinutesBeforeStart: 5 }
    };
    db.dueMeetings = [{ id: "mtg_due" }, { id: "mtg_started" }];
    const queueSend = vi.fn(async () => undefined);

    const queued = await queueDueBotCreations(env({ INVITE_QUEUE: { send: queueSend } }, db));

    expect(queued).toBe(2);
    expect(db.dueCutoffIso).toBe("2026-05-18T14:55:00.000Z");
    expect(queueSend).toHaveBeenNthCalledWith(1, { type: "create_bot", meetingId: "mtg_due" });
    expect(queueSend).toHaveBeenNthCalledWith(2, { type: "create_bot", meetingId: "mtg_started" });
  });

  it("does not create a duplicate Attendee bot when a meeting already has one", async () => {
    const db = new BotCreationD1();
    db.meeting = { ...db.meeting, attendee_bot_id: "bot_existing" };
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await createMeetingBot(env({}, db), "mtg_1");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.claims).toBe(0);
  });

  it("does not create a duplicate Attendee bot for repeated queue deliveries", async () => {
    const db = new BotCreationD1();
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] }))
      .mockResolvedValueOnce(Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "joining" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);

    await createMeetingBot(env({}, db), "mtg_1");
    await createMeetingBot(env({}, db), "mtg_1");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(db.claims).toBe(2);
  });
});
