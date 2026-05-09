import { describe, expect, it, vi } from "vitest";
import { createBotRuntimeApp, type BotRuntimeDeps } from "./app";

describe("bot runtime app", () => {
  it("reports missing runtime dependencies clearly", async () => {
    const app = createBotRuntimeApp({
      env: { BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts" },
      checkBinary: async (name) => name !== "ffmpeg",
      recorder: fakeRecorder(),
      recordingStore: fakeRecordingStore(),
      sendWebhook: vi.fn()
    });

    const response = await app.request("/_ops/health");

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      runtime: "meeting-bot-container",
      missing: ["TEAMS_RECORDER_PASSWORD", "ffmpeg"]
    });
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
      },
      checkBinary: async () => true,
      recorder: fakeRecorder(new Uint8Array([1, 2, 3])),
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
    const completion = webhooks.find((webhook) => webhook.body.includes("post_processing_completed"));
    expect(completion?.url).toBe("https://meeting.minutes.bot/api/webhooks/bot");
    expect(completion?.internalToken).toBe("managed-token");
  });
});

function fakeRecorder(bytes = new Uint8Array([9])): BotRuntimeDeps["recorder"] {
  return {
    record: async () => ({ bytes, contentType: "audio/mpeg", joinMode: "service_account" })
  };
}

function fakeRecordingStore(): BotRuntimeDeps["recordingStore"] {
  return {
    putRecording: async () => undefined
  };
}
