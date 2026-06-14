import { describe, expect, it, vi } from "vitest";
import { BotRecorderError, UploadHttpError, createBotRuntimeApp, type BotRuntimeDeps, type RecorderState } from "./app";

type SentWebhook = { url: string; token: string; body: string };
type SentUpload = { url: string; token: string; key: string; bytes: Uint8Array; contentType: string };

const AUTH = { authorization: "Bearer managed-token" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

function testDeps(overrides: Partial<BotRuntimeDeps> = {}) {
  const webhooks: SentWebhook[] = [];
  const uploads: SentUpload[] = [];
  const deps: BotRuntimeDeps = {
    env: testDepsBaseEnv(),
    checkBinary: async () => true,
    checkTempWritable: async () => true,
    recorder: { record: async () => ({ bytes: new Uint8Array([9]), contentType: "audio/mpeg" }) },
    splitRecording: async () => [],
    uploadArtifact: async (input) => {
      uploads.push(input);
    },
    sendWebhook: async (input) => {
      webhooks.push(input);
    },
    randomUUID: () => "rb_1"
  };
  Object.assign(deps, overrides);
  if (overrides.env) deps.env = { ...testDepsBaseEnv(), ...overrides.env };
  return { deps, webhooks, uploads };
}

function testDepsBaseEnv() {
  return {
    BOT_INTERNAL_TOKEN: "managed-token",
    BOT_RUNTIME_VERSION: "041f23c",
    BOT_CONTAINER_INSTANCE_ID: "primary",
    BOT_WEBHOOK_RETRY_DELAY_MS: "1",
    BOT_UPLOAD_RETRY_DELAY_MS: "1",
    BOT_HEARTBEAT_SECONDS: "0.02"
  };
}

function createBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    botSessionId: "bs_1",
    occurrenceId: "occ_1",
    meetingUrl: "https://teams.microsoft.com/l/meetup-join/abc",
    displayName: "minutesbot",
    joinTimeoutSeconds: 900,
    maxDurationSeconds: 3600,
    recording: { format: "mp3" },
    webhook: { url: "https://api.minutes.bot/internal/bot-webhooks", token: "hook-token" },
    upload: { url: "https://api.minutes.bot/internal/recordings", token: "upload-token", recordingKey: "recordings/occ_1/recording.mp3" },
    ...overrides
  });
}

function parsedWebhooks(webhooks: SentWebhook[]): Array<Record<string, unknown>> {
  return webhooks.map((webhook) => JSON.parse(webhook.body) as Record<string, unknown>);
}

function stateSequence(webhooks: SentWebhook[]): string[] {
  return parsedWebhooks(webhooks)
    .filter((payload) => payload.eventType === "state_change")
    .map((payload) => payload.state as string);
}

function waitingRecorder(states: RecorderState[] = ["joined", "recording"], bytes = new Uint8Array([5, 6])): BotRuntimeDeps["recorder"] {
  return {
    record: async (input) => {
      for (const state of states) await input.onState?.(state);
      await new Promise<void>((resolve) => {
        if (input.abortSignal?.aborted) return resolve();
        input.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { bytes, contentType: "audio/mpeg" };
    }
  };
}

describe("bot runtime ops endpoints", () => {
  it("reports each failing binary in health checks with a 503", async () => {
    const { deps } = testDeps({ checkBinary: async (name) => name !== "ffmpeg" && name !== "pulseaudio" });
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/_ops/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      version: "041f23c",
      containerInstanceId: "primary",
      checks: {
        chromium: { ok: true },
        ffmpeg: { ok: false, detail: "ffmpeg is not available" },
        pulseaudio: { ok: false, detail: "pulseaudio is not available" },
        tempWritable: { ok: true },
        config: { ok: true }
      }
    });
  });

  it("fails the config health check when the internal token is missing", async () => {
    const { deps } = testDeps();
    deps.env = { ...deps.env, BOT_INTERNAL_TOKEN: undefined };
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/_ops/health");

    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: Record<string, unknown> };
    expect(body.checks.config).toEqual({ ok: false, detail: "BOT_INTERNAL_TOKEN is not set" });
  });

  it("passes health without auth when every check is ok", async () => {
    const { deps } = testDeps();
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/_ops/health");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; checks: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(Object.keys(body.checks).sort()).toEqual(["chromium", "config", "ffmpeg", "pulseaudio", "tempWritable"]);
  });

  it("reports ready only when healthy", async () => {
    const healthy = createBotRuntimeApp(testDeps().deps);
    const readyResponse = await healthy.request("/_ops/ready");
    expect(readyResponse.status).toBe(200);
    await expect(readyResponse.json()).resolves.toEqual({ ready: true });

    const unhealthy = createBotRuntimeApp(testDeps({ checkTempWritable: async () => false }).deps);
    const notReadyResponse = await unhealthy.request("/_ops/ready");
    expect(notReadyResponse.status).toBe(503);
    await expect(notReadyResponse.json()).resolves.toEqual({ ready: false, reason: "unhealthy: tempWritable" });
  });

  it("reports not ready while the runtime is at session capacity", async () => {
    const { deps } = testDeps({ env: { BOT_MAX_CONCURRENT_SESSIONS: "1" }, recorder: waitingRecorder() });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    const busyResponse = await app.request("/_ops/ready");

    expect(busyResponse.status).toBe(503);
    await expect(busyResponse.json()).resolves.toEqual({ ready: false, reason: "at capacity (1/1 sessions)" });

    await app.request("/v1/bots/rb_1/cancel", { method: "POST", headers: AUTH });
  });
});

describe("bot runtime auth", () => {
  it("fails closed with 503 when the internal token is not configured", async () => {
    const { deps } = testDeps();
    deps.env = { ...deps.env, BOT_INTERNAL_TOKEN: undefined };
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/v1/bots/rb_1");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ detail: "Meeting bot authorization is not configured" });
  });

  it("rejects missing and mismatched bearer tokens", async () => {
    const app = createBotRuntimeApp(testDeps().deps);

    expect((await app.request("/v1/bots/rb_1")).status).toBe(401);
    expect((await app.request("/v1/bots/rb_1", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });
});

describe("createBot validation", () => {
  it("rejects invalid JSON and schema violations with 400", async () => {
    const app = createBotRuntimeApp(testDeps().deps);

    expect((await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: "{" })).status).toBe(400);
    const missingFields = await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: JSON.stringify({ botSessionId: "bs_1" }) });
    expect(missingFields.status).toBe(400);
  });

  it("rejects non-Teams meeting URLs with 422 before any recorder work", async () => {
    const record = vi.fn();
    const { deps } = testDeps({ recorder: { record } });
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/v1/bots", {
      method: "POST",
      headers: JSON_AUTH,
      body: createBody({ meetingUrl: "https://example.com/not-teams" })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ failureStage: "invalid_meeting_url" });
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects webhook URLs outside the configured allowed origins", async () => {
    const { deps } = testDeps({ env: { BOT_WEBHOOK_ALLOWED_ORIGINS: "https://api.minutes.bot" } });
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/v1/bots", {
      method: "POST",
      headers: JSON_AUTH,
      body: createBody({ webhook: { url: "https://attacker.example.com/hook", token: "hook-token" } })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ detail: "Webhook origin https://attacker.example.com is not allowed" });
  });

  it("returns 409 when a live session already exists for the botSessionId", async () => {
    let runtimeBotSeq = 0;
    const { deps } = testDeps({ recorder: waitingRecorder(), randomUUID: () => `rb_${(runtimeBotSeq += 1)}` });
    const app = createBotRuntimeApp(deps);

    const first = await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    expect(first.status).toBe(201);

    const duplicate = await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({ runtimeBotId: "rb_1" });

    await app.request("/v1/bots/rb_1/cancel", { method: "POST", headers: AUTH });
  });

  it("returns 429 once the concurrency cap is reached", async () => {
    let runtimeBotSeq = 0;
    const { deps } = testDeps({
      env: { BOT_MAX_CONCURRENT_SESSIONS: "1" },
      recorder: waitingRecorder(),
      randomUUID: () => `rb_${(runtimeBotSeq += 1)}`
    });
    const app = createBotRuntimeApp(deps);

    expect((await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() })).status).toBe(201);
    const overCap = await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody({ botSessionId: "bs_2" }) });

    expect(overCap.status).toBe(429);
    await app.request("/v1/bots/rb_1/cancel", { method: "POST", headers: AUTH });
  });
});

describe("bot lifecycle", () => {
  it("runs the happy path through the full state sequence with heartbeats and uploads", async () => {
    const { deps, webhooks, uploads } = testDeps({
      recorder: {
        record: async (input) => {
          const states: RecorderState[] = [
            "warming",
            "browser_starting",
            "prejoin",
            "waiting_for_start",
            "prejoin",
            "waiting_room",
            "joined",
            "recording"
          ];
          for (const state of states) await input.onState?.(state);
          await input.onLog?.({ level: "info", message: "Opening Teams meeting URL" });
          // Stay live long enough for at least one 20ms heartbeat to fire.
          await new Promise((resolve) => setTimeout(resolve, 70));
          return { bytes: new Uint8Array([1, 2, 3]), contentType: "audio/mpeg" };
        }
      }
    });
    const app = createBotRuntimeApp(deps);

    const response = await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ runtimeBotId: "rb_1", state: "created" });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("post_processing_completed"));

    expect(stateSequence(webhooks)).toEqual([
      "created",
      "warming",
      "browser_starting",
      "prejoin",
      "waiting_for_start",
      "prejoin",
      "waiting_room",
      "joined",
      "recording",
      "stopping",
      "uploading",
      "post_processing_completed"
    ]);
    const heartbeats = parsedWebhooks(webhooks).filter((payload) => payload.eventType === "heartbeat");
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      url: "https://api.minutes.bot/internal/recordings",
      token: "upload-token",
      key: "recordings/occ_1/recording.mp3",
      contentType: "audio/mpeg"
    });
    expect(uploads[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));

    const completion = parsedWebhooks(webhooks).find((payload) => payload.state === "post_processing_completed");
    expect(completion).toMatchObject({
      botSessionId: "bs_1",
      runtimeBotId: "rb_1",
      eventType: "state_change",
      recordingKey: "recordings/occ_1/recording.mp3"
    });
    expect(completion?.idempotencyKey).toMatch(/^bs_1:state_change:post_processing_completed:\d+$/);
    expect(webhooks[0]).toMatchObject({ url: "https://api.minutes.bot/internal/bot-webhooks", token: "hook-token" });

    const status = await app.request("/v1/bots/rb_1", { headers: AUTH });
    expect(await status.json()).toMatchObject({
      runtimeBotId: "rb_1",
      botSessionId: "bs_1",
      state: "post_processing_completed",
      startedAt: expect.any(String),
      stoppedAt: expect.any(String),
      lastHeartbeatAt: expect.any(String)
    });
  });

  it("splits oversized recordings into chunks and reports the chunk keys", async () => {
    const { deps, webhooks, uploads } = testDeps({
      recorder: { record: async () => ({ bytes: new Uint8Array([1, 2, 3, 4, 5]), contentType: "audio/mpeg" }) },
      splitRecording: async ({ bytes, chunkSeconds }) => {
        expect(chunkSeconds).toBe(600);
        return [bytes.slice(0, 3), bytes.slice(3)];
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", {
      method: "POST",
      headers: JSON_AUTH,
      body: createBody({
        upload: {
          url: "https://api.minutes.bot/internal/recordings",
          token: "upload-token",
          recordingKey: "recordings/occ_1/recording.mp3",
          chunkKeyPrefix: "recordings/occ_1/chunks/",
          chunkThresholdBytes: 2
        }
      })
    });

    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("post_processing_completed"));
    expect(uploads.map((upload) => upload.key)).toEqual([
      "recordings/occ_1/recording.mp3",
      "recordings/occ_1/chunks/chunk-000.mp3",
      "recordings/occ_1/chunks/chunk-001.mp3"
    ]);
    const completion = parsedWebhooks(webhooks).find((payload) => payload.state === "post_processing_completed");
    expect(completion?.recordingChunkKeys).toEqual(["recordings/occ_1/chunks/chunk-000.mp3", "recordings/occ_1/chunks/chunk-001.mp3"]);
  });

  it("skips chunking below the threshold or without a chunk prefix", async () => {
    const splitRecording = vi.fn(async () => [new Uint8Array([1])]);
    const { deps, webhooks, uploads } = testDeps({ splitRecording });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });

    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("post_processing_completed"));
    expect(splitRecording).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(1);
  });

  it("fails with sign_in_required, uploads redacted diagnostics, and exposes them", async () => {
    const { deps, webhooks, uploads } = testDeps({
      recorder: {
        record: async () => {
          throw new BotRecorderError("Microsoft login form detected. authorization: Bearer hook-secret-token", "sign_in_required", false, {
            screenshotPng: new Uint8Array([137, 80, 78, 71]),
            pageHtml: '<html><head><script>window.token="x"</script></head><body><a href="https://login.example.com/?token=abc123&x=1">Sign in</a></body></html>',
            consoleLines: ["error: request failed with authorization Bearer console-secret"],
            visibleText: "Sign in to join this meeting"
          });
        }
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("failed"));

    const failure = parsedWebhooks(webhooks).find((payload) => payload.state === "failed");
    expect(failure).toMatchObject({ eventType: "state_change", failureStage: "sign_in_required" });
    expect(failure?.failureReason).toContain("Microsoft login form detected");
    expect(failure?.failureReason).not.toContain("hook-secret-token");
    expect(failure?.diagnosticsKeys).toEqual([
      "diagnostics/bs_1/screenshot.png",
      "diagnostics/bs_1/page.html",
      "diagnostics/bs_1/console.log",
      "diagnostics/bs_1/bot.log",
      "diagnostics/bs_1/visible-text.txt"
    ]);

    const decoder = new TextDecoder();
    const html = decoder.decode(uploads.find((upload) => upload.key.endsWith("page.html"))?.bytes);
    expect(html).not.toContain("<script");
    expect(html).toContain("?token=[redacted]");
    expect(html).not.toContain("abc123");
    const consoleLog = decoder.decode(uploads.find((upload) => upload.key.endsWith("console.log"))?.bytes);
    expect(consoleLog).toContain("Bearer [redacted]");
    expect(consoleLog).not.toContain("console-secret");
    const botLog = decoder.decode(uploads.find((upload) => upload.key.endsWith("bot.log"))?.bytes);
    expect(botLog).not.toContain("hook-secret-token");

    const diagnosticsResponse = await app.request("/v1/bots/rb_1/diagnostics", { headers: AUTH });
    expect(diagnosticsResponse.status).toBe(200);
    const diagnostics = (await diagnosticsResponse.json()) as {
      uploadedDiagnostics: string[];
      stateHistory: Array<{ state: string }>;
      logTail: string[];
    };
    expect(diagnostics).toMatchObject({ state: "failed", failureStage: "sign_in_required" });
    expect(diagnostics.uploadedDiagnostics).toHaveLength(5);
    expect(diagnostics.stateHistory.map((entry: { state: string }) => entry.state)).toEqual(["created", "failed"]);
    expect(JSON.stringify(diagnostics.logTail)).not.toContain("hook-secret-token");

    const status = await app.request("/v1/bots/rb_1", { headers: AUTH });
    expect(await status.json()).toMatchObject({ state: "failed", failureStage: "sign_in_required" });
  });

  it("still emits the failure webhook when diagnostics uploads themselves fail", async () => {
    const { deps, webhooks } = testDeps({
      recorder: {
        record: async () => {
          throw new BotRecorderError("Teams blocked guest join with a captcha.", "captcha", false, { visibleText: "Verify you're a real person" });
        }
      },
      uploadArtifact: async () => {
        throw new UploadHttpError(500);
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("failed"));

    const failure = parsedWebhooks(webhooks).find((payload) => payload.state === "failed");
    expect(failure).toMatchObject({ failureStage: "captcha" });
    expect(failure?.diagnosticsKeys).toBeUndefined();
  });

  it("fails with lobby_timeout when the lobby never admits the bot", async () => {
    const { deps, webhooks } = testDeps({
      recorder: {
        record: async (input) => {
          await input.onState?.("prejoin");
          await input.onState?.("waiting_room");
          throw new BotRecorderError("Meeting bot did not join before the 15 minutes timeout expired", "lobby_timeout", false);
        }
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("failed"));

    const failure = parsedWebhooks(webhooks).find((payload) => payload.state === "failed");
    expect(failure).toMatchObject({ failureStage: "lobby_timeout" });
    expect(stateSequence(webhooks)).toEqual(["created", "prejoin", "waiting_room", "failed"]);
  });

  it("cancels a recording bot, uploads the partial audio, and ends as canceled", async () => {
    const { deps, webhooks, uploads } = testDeps({ recorder: waitingRecorder(["joined", "recording"], new Uint8Array([5, 6])) });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("recording"));

    const cancelResponse = await app.request("/v1/bots/rb_1/cancel", { method: "POST", headers: AUTH });
    expect(cancelResponse.status).toBe(202);
    await expect(cancelResponse.json()).resolves.toMatchObject({ runtimeBotId: "rb_1", botSessionId: "bs_1" });

    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("canceled"));
    expect(stateSequence(webhooks)).toEqual(["created", "joined", "recording", "stopping", "uploading", "canceled"]);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.bytes).toEqual(new Uint8Array([5, 6]));
    expect(stateSequence(webhooks)).not.toContain("post_processing_completed");

    const canceled = parsedWebhooks(webhooks).find((payload) => payload.state === "canceled");
    expect(canceled).toMatchObject({ recordingKey: "recordings/occ_1/recording.mp3" });
  });

  it("cancels before any audio without uploading and returns 404 for unknown bots", async () => {
    const { deps, webhooks, uploads } = testDeps({ recorder: waitingRecorder(["prejoin"], new Uint8Array()) });
    const app = createBotRuntimeApp(deps);

    expect((await app.request("/v1/bots/missing/cancel", { method: "POST", headers: AUTH })).status).toBe(404);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("prejoin"));
    await app.request("/v1/bots/rb_1/cancel", { method: "POST", headers: AUTH });

    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("canceled"));
    expect(uploads).toHaveLength(0);
    expect(stateSequence(webhooks)).toEqual(["created", "prejoin", "stopping", "canceled"]);
  });

  it("retries transient recording upload failures before completing", async () => {
    let attempts = 0;
    const { deps, webhooks } = testDeps({
      uploadArtifact: async () => {
        attempts += 1;
        if (attempts === 1) throw new UploadHttpError(503);
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });

    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("post_processing_completed"));
    expect(attempts).toBe(2);
  });

  it("does not retry 4xx uploads and fails with the upload stage", async () => {
    const attemptedKeys: string[] = [];
    const { deps, webhooks } = testDeps({
      uploadArtifact: async ({ key }) => {
        attemptedKeys.push(key);
        throw new UploadHttpError(400);
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });

    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("failed"));
    expect(attemptedKeys.filter((key) => key === "recordings/occ_1/recording.mp3")).toHaveLength(1);
    const failure = parsedWebhooks(webhooks).find((payload) => payload.state === "failed");
    expect(failure).toMatchObject({ failureStage: "upload" });
  });

  it("stops emitting heartbeats once a session is terminal", async () => {
    const { deps, webhooks } = testDeps({
      recorder: {
        record: async () => {
          throw new BotRecorderError("boom", "internal", false);
        }
      }
    });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });
    await vi.waitFor(() => expect(stateSequence(webhooks)).toContain("failed"));

    const heartbeatsAtFailure = parsedWebhooks(webhooks).filter((payload) => payload.eventType === "heartbeat").length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const heartbeatsAfterWait = parsedWebhooks(webhooks).filter((payload) => payload.eventType === "heartbeat").length;
    expect(heartbeatsAfterWait).toBe(heartbeatsAtFailure);
  });

  it("retries webhook delivery and completes the lifecycle even when every delivery fails", async () => {
    const sendWebhook = vi.fn(async () => {
      throw new Error("webhook endpoint down");
    });
    const { deps, uploads } = testDeps({ sendWebhook });
    const app = createBotRuntimeApp(deps);

    await app.request("/v1/bots", { method: "POST", headers: JSON_AUTH, body: createBody() });

    await vi.waitFor(async () => {
      const status = await app.request("/v1/bots/rb_1", { headers: AUTH });
      expect(await status.json()).toMatchObject({ state: "post_processing_completed" });
    });
    expect(uploads).toHaveLength(1);
    expect(sendWebhook.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 404 for unknown bot status and diagnostics", async () => {
    const app = createBotRuntimeApp(testDeps().deps);

    expect((await app.request("/v1/bots/missing", { headers: AUTH })).status).toBe(404);
    expect((await app.request("/v1/bots/missing/diagnostics", { headers: AUTH })).status).toBe(404);
  });
});
