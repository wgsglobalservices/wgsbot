import { describe, expect, it, vi } from "vitest";
import { createBotRuntimeApp, type BotRuntimeDeps } from "./app";

describe("bot runtime app", () => {
  it("reports missing runtime dependencies clearly", async () => {
    const app = createBotRuntimeApp({
      env: { BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts", BOT_ALLOW_GUEST_JOIN: "false" },
      checkBinary: async (name) => name !== "ffmpeg" && name !== "pulseaudio",
      recorder: fakeRecorder(),
      recordingStore: fakeRecordingStore(),
      sendWebhook: vi.fn()
    });

    const response = await app.request("/_ops/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      runtime: "meeting-bot-container",
      missing: ["BOT_ALLOW_GUEST_JOIN", "ffmpeg", "pulseaudio"]
    });
  });

  it("passes health in guest mode without a recorder password", async () => {
    const app = createBotRuntimeApp({
      env: {
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
        BOT_RUNTIME_VERSION: "041f23c",
        BOT_CONTAINER_INSTANCE_ID: "production-test-container"
      },
      checkBinary: async () => true,
      recorder: fakeRecorder(),
      recordingStore: fakeRecordingStore(),
      sendWebhook: vi.fn()
    });

    const response = await app.request("/_ops/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      runtime: "meeting-bot-container",
      missing: [],
      auth: "guest",
      version: "041f23c",
      diagnosticVersion: "041f23c",
      containerInstanceId: "production-test-container"
    });
  });

  it("uses guest mode even when legacy recorder credentials are present", async () => {
    let recorderInput: Parameters<BotRuntimeDeps["recorder"]["record"]>[0] | null = null;
    const app = createBotRuntimeApp({
      env: {
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
        TEAMS_RECORDER_EMAIL: "notetaker@company.com",
        TEAMS_RECORDER_PASSWORD: "password"
      } as unknown as BotRuntimeDeps["env"],
      checkBinary: async () => true,
      recorder: {
        record: async (input) => {
          recorderInput = input;
          await input.onState?.("joined");
          return { bytes: new Uint8Array([1]), contentType: "audio/mpeg", joinMode: "guest" };
        }
      },
      recordingStore: fakeRecordingStore(),
      sendWebhook: vi.fn(),
      randomUUID: () => "bot_guest"
    });

    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: { authorization: "Bearer managed-token", "content-type": "application/json" },
      body: JSON.stringify({
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        bot_name: "minutesbot",
        external_media_storage_settings: { bucket_name: "minutesbot-artifacts" }
      })
    });

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(recorderInput).not.toBeNull());
    expect(recorderInput).toMatchObject({ allowGuestJoin: true });
    expect(recorderInput).not.toHaveProperty("serviceAccount");
  });

  it("creates a bot, records to the supplied R2 key, and emits a managed completion webhook", async () => {
    const stored: Array<{ bucketName: string; key: string; bytes: Uint8Array; contentType: string }> = [];
    const webhooks: Array<{ url: string; body: string; internalToken?: string }> = [];
    const app = createBotRuntimeApp({
      env: {
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
        TEAMS_RECORDER_EMAIL: "notetaker@company.com",
        TEAMS_RECORDER_PASSWORD: "password"
      } as unknown as BotRuntimeDeps["env"],
      checkBinary: async () => true,
      recorder: fakeRecorder(new Uint8Array([1, 2, 3]), "joined"),
      recordingStore: {
        putRecording: async (input) => {
          stored.push(input);
        }
      },
      sendWebhook: async (input) => {
        webhooks.push(input);
      },
      randomUUID: () => "bot_1",
      now: () => "2026-05-09T12:00:00.000Z"
    });

    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: { authorization: "Bearer managed-token", "content-type": "application/json" },
      body: JSON.stringify({
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        bot_name: "minutesbot",
        recording_settings: { format: "mp3" },
        external_media_storage_settings: {
          bucket_name: "minutesbot-artifacts",
          recording_file_name: "recordings/mtg_1/recording.mp3"
        },
        webhooks: [{ url: "https://meeting.minutes.bot/api/webhooks/bot", triggers: ["bot.state_change"] }],
        metadata: { minutesbot_meeting_id: "mtg_1" }
      })
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "bot_1", state: "queued", recording_state: "pending" });
    await vi.waitFor(() => expect(stored).toHaveLength(1));
    expect(stored[0]).toMatchObject({
      bucketName: "minutesbot-artifacts",
      key: "recordings/mtg_1/recording.mp3",
      contentType: "audio/mpeg"
    });
    expect(stored[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(webhooks.some((webhook) => webhook.body.includes("post_processing_completed"))).toBe(true));
    expect(webhooks.some((webhook) => webhook.body.includes('"new_state":"joined"'))).toBe(true);
    expect(webhooks.some((webhook) => webhook.body.includes('"new_state":"recording"'))).toBe(true);
    const completion = webhooks.find((webhook) => webhook.body.includes("post_processing_completed"));
    expect(completion?.url).toBe("https://meeting.minutes.bot/api/webhooks/bot");
    expect(completion?.internalToken).toBe("managed-token");
  });

  it("applies recorder-emitted recording state before uploading captured audio", async () => {
    const events: string[] = [];
    const webhooks: Array<{ body: string }> = [];
    const app = createBotRuntimeApp({
      env: {
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts"
      },
      checkBinary: async () => true,
      recorder: {
        record: async (input) => {
          await input.onState?.("joined");
          await input.onState?.("recording");
          events.push("recorder:recording");
          return { bytes: new Uint8Array([1]), contentType: "audio/mpeg", joinMode: "guest" };
        }
      },
      recordingStore: {
        putRecording: async () => {
          events.push("store:upload");
        }
      },
      sendWebhook: async (input) => {
        webhooks.push(input);
      },
      randomUUID: () => "bot_recording"
    });

    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: { authorization: "Bearer managed-token", "content-type": "application/json" },
      body: JSON.stringify({
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        bot_name: "minutesbot",
        webhooks: [{ url: "https://meeting.minutes.bot/api/webhooks/bot", triggers: ["bot.state_change"] }],
        external_media_storage_settings: { bucket_name: "minutesbot-artifacts" }
      })
    });

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(events).toContain("store:upload"));
    const recordingWebhook = JSON.parse(webhooks.find((webhook) => webhook.body.includes('"new_state":"recording"'))?.body ?? "{}");
    expect(recordingWebhook.data).toMatchObject({
      event_type: "state_change",
      new_state: "recording",
      recording_state: "recording"
    });
    expect(events.indexOf("recorder:recording")).toBeLessThan(events.indexOf("store:upload"));
  });

  it("passes the configured join timeout into the recorder", async () => {
    let joinTimeoutSeconds: number | undefined;
    const app = createBotRuntimeApp({
      env: {
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts"
      },
      checkBinary: async () => true,
      recorder: {
        record: async (input) => {
          joinTimeoutSeconds = input.joinTimeoutSeconds;
          await input.onState?.("joined");
          return { bytes: new Uint8Array([1]), contentType: "audio/mpeg", joinMode: "guest" };
        }
      },
      recordingStore: fakeRecordingStore(),
      sendWebhook: vi.fn(),
      randomUUID: () => "bot_timeout"
    });

    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: { authorization: "Bearer managed-token", "content-type": "application/json" },
      body: JSON.stringify({
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        bot_name: "minutesbot",
        join_timeout_seconds: 420,
        external_media_storage_settings: { bucket_name: "minutesbot-artifacts" }
      })
    });

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(joinTimeoutSeconds).toBe(420));
  });

  it("emits a fatal webhook when the recorder times out before joining", async () => {
    const webhooks: Array<{ body: string }> = [];
    const app = createBotRuntimeApp({
      env: {
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts"
      },
      checkBinary: async () => true,
      recorder: {
        record: async (input) => {
          await input.onState?.("prejoin");
          throw new Error("Meeting bot did not join before the 1 second timeout expired");
        }
      },
      recordingStore: fakeRecordingStore(),
      sendWebhook: async (input) => {
        webhooks.push(input);
      },
      randomUUID: () => "bot_timeout"
    });

    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: { authorization: "Bearer managed-token", "content-type": "application/json" },
      body: JSON.stringify({
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        bot_name: "minutesbot",
        join_timeout_seconds: 1,
        webhooks: [{ url: "https://meeting.minutes.bot/api/webhooks/bot", triggers: ["bot.state_change"] }],
        external_media_storage_settings: { bucket_name: "minutesbot-artifacts" }
      })
    });

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(webhooks.some((webhook) => webhook.body.includes("fatal_error"))).toBe(true));
    const fatal = JSON.parse(webhooks.find((webhook) => webhook.body.includes("fatal_error"))?.body ?? "{}");
    expect(fatal.data).toMatchObject({
      event_type: "fatal_error",
      new_state: "failed",
      transcription_state: "failed",
      recording_state: "failed",
      latest_error: "Meeting bot did not join before the 1 second timeout expired"
    });
  });

  it("emits runtime log webhooks before completion", async () => {
    const webhooks: Array<{ body: string }> = [];
    const app = createBotRuntimeApp({
      env: {
        BOT_INTERNAL_TOKEN: "managed-token",
        BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts"
      },
      checkBinary: async () => true,
      recorder: {
        record: async (input) => {
          await input.onLog?.({ level: "info", message: "Opening Teams meeting URL", details: { stage: "browser" } });
          await input.onState?.("joined");
          return { bytes: new Uint8Array([1]), contentType: "audio/mpeg", joinMode: "guest" };
        }
      },
      recordingStore: fakeRecordingStore(),
      sendWebhook: async (input) => {
        webhooks.push(input);
      },
      randomUUID: () => "bot_logs",
      now: () => "2026-05-10T22:16:18.000Z"
    });

    const response = await app.request("/api/v1/bots", {
      method: "POST",
      headers: { authorization: "Bearer managed-token", "content-type": "application/json" },
      body: JSON.stringify({
        meeting_url: "https://teams.microsoft.com/l/meetup-join/abc",
        bot_name: "minutesbot",
        webhooks: [{ url: "https://meeting.minutes.bot/api/webhooks/bot", triggers: ["bot.state_change", "bot_logs.update"] }],
        external_media_storage_settings: { bucket_name: "minutesbot-artifacts" },
        metadata: { minutesbot_meeting_id: "mtg_1" }
      })
    });

    expect(response.status).toBe(201);
    await vi.waitFor(() => expect(webhooks.some((webhook) => webhook.body.includes("bot_logs.update"))).toBe(true));
    const log = JSON.parse(webhooks.find((webhook) => webhook.body.includes("bot_logs.update"))?.body ?? "{}");
    expect(log).toMatchObject({
      idempotency_key: "bot_logs-log-1",
      bot_id: "bot_logs",
      trigger: "bot_logs.update",
      data: {
        event_type: "runtime_log",
        level: "info",
        message: "Opening Teams meeting URL",
        state: "joining",
        details: { stage: "browser" }
      }
    });
  });
});

function fakeRecorder(bytes = new Uint8Array([9]), state?: "waiting_room" | "joined"): BotRuntimeDeps["recorder"] {
  return {
    record: async (input) => {
      if (state) await input.onState?.(state);
      return { bytes, contentType: "audio/mpeg", joinMode: "guest" };
    }
  };
}

function fakeRecordingStore(): BotRuntimeDeps["recordingStore"] {
  return {
    putRecording: async () => undefined
  };
}
