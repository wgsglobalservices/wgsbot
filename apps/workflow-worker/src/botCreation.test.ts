import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { createMeetingBot, monitorBotJoin } from "./botCreation";
import type { MeetingRow } from "@minutesbot/db";
import type { WorkflowEnv } from "./env";

class BotCreationD1 {
  meeting: Partial<MeetingRow> = {
    id: "mtg_1",
    calendar_uid: "teams-link-1",
    teams_join_url: "https://teams.microsoft.com/l/meetup-join/abc",
    status: "SCHEDULED"
  };
  settings = defaultSettings;
  statusUpdates: Array<{ status: string; latestError: string | null }> = [];
  botStateUpdates: Array<{
    botId: string | null;
    state: string | null;
    transcriptionState: string | null;
    recordingState: string | null;
    status: string | null;
    latestError: string | null;
  }> = [];
  auditLogs: Array<{ eventType: string; metadata: unknown }> = [];
  webhookEvents: Array<Record<string, unknown>> = [];

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
          db.meeting.status = this.values[0] as MeetingRow["status"];
          db.meeting.latest_error = this.values[1] as string | null;
        }
        if (sql.includes("attendee_bot_id = COALESCE")) {
          const update = {
            botId: this.values[0] as string | null,
            state: this.values[1] as string | null,
            transcriptionState: this.values[2] as string | null,
            recordingState: this.values[3] as string | null,
            status: this.values[5] as string | null,
            latestError: this.values[6] as string | null
          };
          db.botStateUpdates.push(update);
          db.meeting.attendee_bot_id = update.botId ?? db.meeting.attendee_bot_id;
          db.meeting.attendee_bot_state = update.state ?? db.meeting.attendee_bot_state;
          db.meeting.attendee_transcription_state = update.transcriptionState ?? db.meeting.attendee_transcription_state;
          db.meeting.attendee_recording_state = update.recordingState ?? db.meeting.attendee_recording_state;
          db.meeting.status = (update.status as MeetingRow["status"] | null) ?? db.meeting.status;
          db.meeting.latest_error = update.latestError ?? db.meeting.latest_error;
        }
        if (sql.startsWith("INSERT INTO audit_logs")) {
          db.auditLogs.push({ eventType: this.values[2] as string, metadata: this.values[5] ? JSON.parse(this.values[5] as string) : null });
        }
        return { success: true };
      },
      async all<T>() {
        if (sql.includes("FROM attendee_webhook_events")) return { results: db.webhookEvents as T[] };
        return { results: [] };
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
    const inviteQueue = { send: vi.fn() };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/_ops/health")) return Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] });
        return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "queued" }, { status: 201 });
      })
    );

    await createMeetingBot(env({ INVITE_QUEUE: inviteQueue }, db), "mtg_1");

    const createRequest = requests.find((request) => request.url.endsWith("/api/v1/bots"));
    expect(createRequest).toBeDefined();
    expect(JSON.parse(createRequest?.init?.body as string)).toMatchObject({
      meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
      bot_name: "minutesbot",
      recording_settings: { format: "mp3" },
      external_media_storage_settings: {
        bucket_name: "minutesbot-artifacts",
        recording_file_name: "recordings/mtg_1/recording.mp3"
      },
      join_timeout_seconds: 900,
      webhooks: [
        {
          url: "https://minutesbot-webhook.example.com/api/webhooks/bot"
        }
      ]
    });
    expect(JSON.parse(createRequest?.init?.body as string)).not.toHaveProperty("bot_chat_message");
    expect(db.meeting).toMatchObject({
      attendee_bot_id: "bot_1",
      attendee_bot_state: "queued",
      status: "BOT_CREATED"
    });
    expect(inviteQueue.send).toHaveBeenCalledWith({ type: "monitor_bot_join", meetingId: "mtg_1", botId: "bot_1" }, { delaySeconds: 900 });
  });

  it("does not downgrade bot state when a lifecycle webhook wins the creation race", async () => {
    const db = new BotCreationD1();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/_ops/health")) return Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] });
        db.meeting = {
          ...db.meeting,
          attendee_bot_id: "bot_1",
          attendee_bot_state: "joining",
          attendee_transcription_state: "pending",
          attendee_recording_state: "pending",
          status: "BOT_JOINING"
        };
        return Response.json(
          {
            id: "bot_1",
            meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
            state: "queued",
            transcription_state: "pending",
            recording_state: "pending"
          },
          { status: 201 }
        );
      })
    );

    await createMeetingBot(env({}, db), "mtg_1");

    expect(db.meeting).toMatchObject({
      attendee_bot_id: "bot_1",
      attendee_bot_state: "joining",
      attendee_transcription_state: "pending",
      attendee_recording_state: "pending",
      status: "BOT_JOINING"
    });
  });

  it("uses a recorded same-bot webhook state when the event lands before the meeting row update", async () => {
    const db = new BotCreationD1();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith("/_ops/health")) return Response.json({ ok: true, runtime: "cloudflare-containers", missing: [] });
        db.webhookEvents = [
          {
            attendee_bot_id: "bot_1",
            trigger: "bot.state_change",
            event_type: "state_change",
            payload: JSON.stringify({
              data: {
                event_type: "state_change",
                new_state: "joining",
                transcription_state: "pending",
                recording_state: "pending"
              }
            }),
            created_at: "2026-05-10T07:20:12.206Z"
          }
        ];
        return Response.json(
          {
            id: "bot_1",
            meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
            state: "queued",
            transcription_state: "pending",
            recording_state: "pending"
          },
          { status: 201 }
        );
      })
    );

    await createMeetingBot(env({}, db), "mtg_1");

    expect(db.meeting).toMatchObject({
      attendee_bot_id: "bot_1",
      attendee_bot_state: "joining",
      attendee_transcription_state: "pending",
      attendee_recording_state: "pending",
      status: "BOT_JOINING"
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
        return new Response(JSON.stringify({ ok: false, runtime: "meeting-bot-container", missing: ["ffmpeg", "pulseaudio"] }), {
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
      latestError: "BOT_UNHEALTHY: Meeting bot health check failed: missing ffmpeg, pulseaudio"
    });
    expect(db.auditLogs.at(-1)).toMatchObject({
      eventType: "bot.fatal_error",
      metadata: { code: "BOT_UNHEALTHY" }
    });
  });

  it("requeues a same-bot prejoin state once before marking it fatal", async () => {
    const db = new BotCreationD1();
    const inviteQueue = { send: vi.fn() };
    db.meeting = {
      ...db.meeting,
      attendee_bot_id: "bot_1",
      attendee_bot_state: "prejoin",
      attendee_transcription_state: "pending",
      attendee_recording_state: "pending",
      status: "BOT_JOINING"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe("https://meeting-bot.example.com/api/v1/bots/bot_1");
        return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "prejoin" });
      })
    );

    await monitorBotJoin(env({ INVITE_QUEUE: inviteQueue }, db), "mtg_1", "bot_1");

    expect(db.botStateUpdates).toEqual([]);
    expect(inviteQueue.send).toHaveBeenCalledWith({ type: "monitor_bot_join", meetingId: "mtg_1", botId: "bot_1", attempt: 1 }, { delaySeconds: 60 });
  });

  it("marks a same-bot prejoin state fatal with state-specific text after monitor grace expires", async () => {
    const db = new BotCreationD1();
    db.meeting = {
      ...db.meeting,
      attendee_bot_id: "bot_1",
      attendee_bot_state: "prejoin",
      attendee_transcription_state: "pending",
      attendee_recording_state: "pending",
      status: "BOT_JOINING"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "prejoin" }))
    );

    await monitorBotJoin(env({}, db), "mtg_1", "bot_1", 1);

    expect(db.botStateUpdates.at(-1)).toMatchObject({
      botId: "bot_1",
      state: "failed",
      transcriptionState: "failed",
      recordingState: "failed",
      status: "BOT_FATAL_ERROR",
      latestError: "Meeting bot remained on the Teams pre-join screen after the 15 minute join timeout expired"
    });
  });

  it("preserves runtime latest_error instead of replacing it with monitor timeout text", async () => {
    const db = new BotCreationD1();
    db.meeting = {
      ...db.meeting,
      attendee_bot_id: "bot_1",
      attendee_bot_state: "prejoin",
      attendee_transcription_state: "pending",
      attendee_recording_state: "pending",
      status: "BOT_JOINING"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "bot_1",
          meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
          state: "failed",
          transcription_state: "failed",
          recording_state: "failed",
          latest_error: "Teams guest join is blocked or requires sign-in."
        })
      )
    );

    await monitorBotJoin(env({}, db), "mtg_1", "bot_1");

    expect(db.botStateUpdates.at(-1)).toMatchObject({
      botId: "bot_1",
      state: "failed",
      transcriptionState: "failed",
      recordingState: "failed",
      status: "BOT_FATAL_ERROR",
      latestError: "Teams guest join is blocked or requires sign-in."
    });
  });

  it("ignores stale monitor messages for old bot ids", async () => {
    const db = new BotCreationD1();
    db.meeting = {
      ...db.meeting,
      attendee_bot_id: "bot_new",
      attendee_bot_state: "joining",
      status: "BOT_JOINING"
    };

    await monitorBotJoin(env({}, db), "mtg_1", "bot_old");

    expect(db.botStateUpdates).toEqual([]);
  });

  it("applies an advanced runtime state instead of failing the monitored bot", async () => {
    const db = new BotCreationD1();
    db.meeting = {
      ...db.meeting,
      attendee_bot_id: "bot_1",
      attendee_bot_state: "joining",
      status: "BOT_JOINING"
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "bot_1",
          meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
          state: "recording",
          transcription_state: "pending",
          recording_state: "recording"
        })
      )
    );

    await monitorBotJoin(env({}, db), "mtg_1", "bot_1");

    expect(db.botStateUpdates.at(-1)).toMatchObject({
      botId: "bot_1",
      state: "recording",
      transcriptionState: "pending",
      recordingState: "recording",
      status: "BOT_RECORDING",
      latestError: null
    });
  });
});
