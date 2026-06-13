import { afterEach, describe, expect, it, vi } from "vitest";
import { BotClient, BotClientError, botWebhookPayloadSchema, type CreateBotRuntimeInput } from "./index";

const createInput: CreateBotRuntimeInput = {
  botSessionId: "bs_1",
  occurrenceId: "occ_1",
  meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
  displayName: "minutesbot",
  joinTimeoutSeconds: 900,
  maxDurationSeconds: 3600,
  recording: { format: "mp3" },
  webhook: { url: "https://api.minutes.bot/internal/bot-webhooks", token: "hook-token" },
  upload: {
    url: "https://api.minutes.bot/internal/recordings",
    token: "upload-token",
    recordingKey: "recordings/occ_1/recording.mp3"
  }
};

describe("BotClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates bots against /v1/bots with bearer auth and the exact contract body", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ runtimeBotId: "rb_1", state: "created" }, { status: 201 })
    );
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot/", internalToken: "managed-token", fetcher });

    const created = await client.createBot(createInput);

    expect(created).toEqual({ runtimeBotId: "rb_1", state: "created" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-bot.minutes.bot/v1/bots",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer managed-token" })
      })
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual(createInput);
  });

  it("retrieves runtime bot status by runtimeBotId", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        runtimeBotId: "rb_1",
        botSessionId: "bs_1",
        state: "recording",
        createdAt: "2026-06-12T10:00:00.000Z",
        startedAt: "2026-06-12T10:01:00.000Z",
        lastHeartbeatAt: "2026-06-12T10:02:00.000Z"
      })
    );
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", internalToken: "managed-token", fetcher });

    await expect(client.getBot("rb_1")).resolves.toMatchObject({ runtimeBotId: "rb_1", state: "recording" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-bot.minutes.bot/v1/bots/rb_1",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer managed-token" }) })
    );
  });

  it("cancels a bot and accepts the 202 response", async () => {
    const fetcher = vi.fn(async () => Response.json({ runtimeBotId: "rb_1", botSessionId: "bs_1", state: "recording" }, { status: 202 }));
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", internalToken: "managed-token", fetcher });

    await expect(client.cancelBot("rb_1")).resolves.toMatchObject({ runtimeBotId: "rb_1", state: "recording" });
    expect(fetcher).toHaveBeenCalledWith("https://meeting-bot.minutes.bot/v1/bots/rb_1/cancel", expect.objectContaining({ method: "POST" }));
  });

  it("retrieves diagnostics including state history and uploaded artifact keys", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        state: "failed",
        stateHistory: [
          { state: "created", at: "2026-06-12T10:00:00.000Z" },
          { state: "failed", at: "2026-06-12T10:05:00.000Z" }
        ],
        failureStage: "sign_in_required",
        failureReason: "Microsoft login form detected",
        logTail: ["{}"],
        uploadedDiagnostics: ["diagnostics/bs_1/screenshot.png"]
      })
    );
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", internalToken: "managed-token", fetcher });

    const diagnostics = await client.getDiagnostics("rb_1");

    expect(diagnostics.failureStage).toBe("sign_in_required");
    expect(diagnostics.uploadedDiagnostics).toEqual(["diagnostics/bs_1/screenshot.png"]);
    expect(fetcher).toHaveBeenCalledWith("https://meeting-bot.minutes.bot/v1/bots/rb_1/diagnostics", expect.anything());
  });

  it("returns the per-check health body even when the runtime reports 503", async () => {
    const body = {
      ok: false,
      version: "041f23c",
      containerInstanceId: "primary",
      checks: {
        chromium: { ok: true },
        ffmpeg: { ok: false, detail: "ffmpeg is not available" },
        pulseaudio: { ok: true },
        tempWritable: { ok: true },
        config: { ok: true }
      }
    };
    const fetcher = vi.fn(async () => Response.json(body, { status: 503 }));
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", fetcher });

    await expect(client.checkHealth()).resolves.toEqual(body);
    expect(fetcher).toHaveBeenCalledWith("https://meeting-bot.minutes.bot/_ops/health", expect.anything());
  });

  it("returns readiness with a reason when the runtime is not ready", async () => {
    const fetcher = vi.fn(async () => Response.json({ ready: false, reason: "at capacity (5/5 sessions)" }, { status: 503 }));
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", fetcher });

    await expect(client.checkReady()).resolves.toEqual({ ready: false, reason: "at capacity (5/5 sessions)" });
    expect(fetcher).toHaveBeenCalledWith("https://meeting-bot.minutes.bot/_ops/ready", expect.anything());
  });

  it("maps 401 to a non-retryable auth error with the response detail", async () => {
    const fetcher = vi.fn(async () => Response.json({ detail: "Unauthorized" }, { status: 401 }));
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", internalToken: "wrong", fetcher });

    await expect(client.getBot("rb_1")).rejects.toMatchObject({
      status: 401,
      retryable: false,
      code: "BOT_AUTH_FAILED",
      message: expect.stringContaining("Unauthorized")
    });
  });

  it("marks 5xx, 429, and 409 statuses with the correct retryable flag", async () => {
    const statuses: Array<[number, boolean, string]> = [
      [500, true, "BOT_UPSTREAM_ERROR"],
      [429, true, "BOT_RATE_LIMITED"],
      [409, false, "BOT_CONFLICT"],
      [422, false, "BOT_INVALID_MEETING_URL"]
    ];
    for (const [status, retryable, code] of statuses) {
      const fetcher = vi.fn(async () => Response.json({ detail: "nope" }, { status }));
      const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", internalToken: "managed-token", fetcher });
      await expect(client.createBot(createInput)).rejects.toMatchObject({ status, retryable, code });
    }
  });

  it("explains Cloudflare 530 as a bot runtime domain or deploy problem", async () => {
    const fetcher = vi.fn(async () => new Response("<html>error 530</html>", { status: 530 }));
    const client = new BotClient({ baseUrl: "https://minutesbot-meeting-api.wgsglobal.app", internalToken: "managed-token", fetcher });

    await expect(client.checkHealth()).rejects.toMatchObject({
      status: 530,
      retryable: true,
      code: "BOT_RUNTIME_DOMAIN_UNAVAILABLE",
      message: expect.stringContaining("minutesbot-meeting-api.wgsglobal.app")
    });
    await expect(client.checkHealth()).rejects.toMatchObject({
      message: expect.stringContaining("pnpm bot:deploy")
    });
  });

  it("normalizes network failures into retryable typed errors", async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", fetcher });

    await expect(client.checkReady()).rejects.toMatchObject({ code: "BOT_NETWORK_ERROR", retryable: true, status: 0 });
  });

  it("normalizes timeouts into retryable typed errors", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", fetcher, timeoutMs: 5 });

    await expect(client.getBot("rb_1")).rejects.toMatchObject({ code: "BOT_REQUEST_TIMEOUT", status: 408, retryable: true });
  });

  it("surfaces non-JSON success bodies as typed errors", async () => {
    const fetcher = vi.fn(async () => new Response("not json", { status: 200 }));
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot", fetcher });

    await expect(client.getBot("rb_1")).rejects.toBeInstanceOf(BotClientError);
    await expect(client.getBot("rb_1")).rejects.toMatchObject({ code: "BOT_INVALID_RESPONSE" });
  });

  it("calls default global fetch with a valid host receiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async function (this: unknown, _url: string | URL | Request, _init?: RequestInit) {
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        return Response.json({ runtimeBotId: "rb_1", botSessionId: "bs_1", state: "created", createdAt: "x", lastHeartbeatAt: "x" });
      })
    );
    const client = new BotClient({ baseUrl: "https://meeting-bot.minutes.bot" });

    await expect(client.getBot("rb_1")).resolves.toMatchObject({ runtimeBotId: "rb_1" });
  });
});

describe("botWebhookPayloadSchema", () => {
  const validPayload = {
    idempotencyKey: "bs_1:state_change:recording:7",
    botSessionId: "bs_1",
    runtimeBotId: "rb_1",
    eventType: "state_change",
    state: "recording",
    timestamp: "2026-06-12T10:00:00.000Z"
  };

  it("accepts a minimal state_change payload", () => {
    expect(botWebhookPayloadSchema.parse(validPayload)).toMatchObject({ state: "recording" });
  });

  it("accepts a terminal failure payload with stage, reason, and diagnostics keys", () => {
    const parsed = botWebhookPayloadSchema.parse({
      ...validPayload,
      eventType: "state_change",
      state: "failed",
      failureStage: "sign_in_required",
      failureReason: "Microsoft login form detected",
      diagnosticsKeys: ["diagnostics/bs_1/screenshot.png", "diagnostics/bs_1/bot.log"]
    });
    expect(parsed.failureStage).toBe("sign_in_required");
  });

  it("accepts a completion payload with recording and chunk keys", () => {
    const parsed = botWebhookPayloadSchema.parse({
      ...validPayload,
      state: "post_processing_completed",
      recordingKey: "recordings/occ_1/recording.mp3",
      recordingChunkKeys: ["recordings/occ_1/chunks/chunk-000.mp3"]
    });
    expect(parsed.recordingChunkKeys).toHaveLength(1);
  });

  it("rejects unknown states, unknown event types, unknown stages, and bad timestamps", () => {
    expect(botWebhookPayloadSchema.safeParse({ ...validPayload, state: "ended" }).success).toBe(false);
    expect(botWebhookPayloadSchema.safeParse({ ...validPayload, eventType: "bot.state_change" }).success).toBe(false);
    expect(botWebhookPayloadSchema.safeParse({ ...validPayload, failureStage: "mystery" }).success).toBe(false);
    expect(botWebhookPayloadSchema.safeParse({ ...validPayload, timestamp: "yesterday" }).success).toBe(false);
  });
});
