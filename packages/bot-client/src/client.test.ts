import { afterEach, describe, expect, it, vi } from "vitest";
import { stableStringify } from "@minutesbot/shared";
import { BotClient, verifyBotWebhookSignature } from "./index";

describe("BotClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates bots without requiring user-managed auth and normalizes payload", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" })
    );
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot/", fetcher });

    const bot = await client.createBot({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      botName: "minutesbot",
      metadata: { minutesbot_meeting_id: "mtg_1" }
    });

    expect(bot.id).toBe("bot_1");
    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/api/v1/bots",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("meeting_url")
      })
    );
  });

  it("adds managed internal auth when supplied by deployment", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" })
    );
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot/", internalToken: "managed-token", fetcher });

    await client.getBot("bot_1");

    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/api/v1/bots/bot_1",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer managed-token" })
      })
    );
  });

  it("serializes recording and external media storage settings when creating bots", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" })
    );
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot/", fetcher });

    await client.createBot({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      botName: "minutesbot",
      recordingSettings: { format: "mp3" },
      externalMediaStorageSettings: {
        bucketName: "minutesbot-artifacts",
        recordingFileName: "recordings/mtg_1/recording.mp3"
      }
    } as Parameters<BotClient["createBot"]>[0] & {
      recordingSettings: { format: "mp3" };
      externalMediaStorageSettings: { bucketName: string; recordingFileName: string };
    });

    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({
      recording_settings: { format: "mp3" },
      external_media_storage_settings: {
        bucket_name: "minutesbot-artifacts",
        recording_file_name: "recordings/mtg_1/recording.mp3"
      }
    });
  });

  it("serializes custom bot images when creating bots", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" })
    );
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot/", fetcher });

    await client.createBot({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      botName: "Meeting Bot",
      botImage: {
        type: "image/png",
        data: "iVBORw0KGgo="
      }
    });

    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      bot_name: "Meeting Bot",
      bot_image: {
        type: "image/png",
        data: "iVBORw0KGgo="
      }
    });
  });

  it("serializes a chat message to send when the bot joins", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" })
    );
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot/", fetcher });

    await client.createBot({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      botName: "Meeting Notetaker",
      botChatMessage: "Hi, I'm Meeting Notetaker, an automated meeting notetaker."
    });

    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      bot_chat_message: {
        to: "everyone",
        message: "Hi, I'm Meeting Notetaker, an automated meeting notetaker."
      }
    });
  });

  it("normalizes rate limits into retryable typed errors", async () => {
    const fetcher = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot", fetcher });

    await expect(client.getBot("bot_1")).rejects.toMatchObject({ code: "BOT_RATE_LIMITED", retryable: true });
  });

  it("retrieves bot recordings with content metadata", async () => {
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const fetcher = vi.fn(async () => new Response(audio, { headers: { "content-type": "audio/mp4", "content-length": "3" } }));
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot", fetcher });

    const recording = await client.getBotRecording("bot_1");

    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/api/v1/bots/bot_1/recording",
      expect.objectContaining({ headers: expect.objectContaining({ "content-type": "application/json" }) })
    );
    expect(recording.contentType).toBe("audio/mp4");
    expect(recording.sizeBytes).toBe(3);
    expect(new Uint8Array(recording.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("can force meeting bot transcript retrieval", async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot", fetcher });

    await client.getBotTranscript("bot_1", { force: true });

    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/api/v1/bots/bot_1/transcript?force=true",
      expect.objectContaining({ headers: expect.objectContaining({ "content-type": "application/json" }) })
    );
  });

  it("does not force transcript retrieval by default", async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot", fetcher });

    await client.getBotTranscript("bot_1");

    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/api/v1/bots/bot_1/transcript",
      expect.objectContaining({ headers: expect.objectContaining({ "content-type": "application/json" }) })
    );
  });

  it("rejects JSON recording responses as unavailable media", async () => {
    const fetcher = vi.fn(async () => Response.json({ detail: "Recording is not available yet" }));
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot", fetcher });

    await expect(client.getBotRecording("bot_1")).rejects.toMatchObject({
      code: "BOT_RECORDING_UNAVAILABLE",
      retryable: true
    });
  });

  it("calls default global fetch with a valid host receiver", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async function (this: unknown, _url: string | URL | Request, _init?: RequestInit) {
        if (this !== globalThis) throw new TypeError("Illegal invocation");
        return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" });
      })
    );
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot" });

    await expect(client.getBot("bot_1")).resolves.toMatchObject({ id: "bot_1" });
  });

  it("checks the first-party runtime health endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, runtime: "meeting-bot-container", missing: [] }));
    const client = new BotClient({ baseUrl: "https://meeting-api.minutes.bot", fetcher });

    await expect(client.checkHealth()).resolves.toEqual({ ok: true, runtime: "meeting-bot-container", missing: [] });
    expect(fetcher).toHaveBeenCalledWith(
      "https://meeting-api.minutes.bot/_ops/health",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });
});

describe("webhook verification", () => {
  it("verifies canonicalized HMAC signatures", async () => {
    const secret = Buffer.from("webhook-secret").toString("base64");
    const rawBody = JSON.stringify({ b: 2, a: { z: true, c: "value" } });
    const key = await crypto.subtle.importKey("raw", Buffer.from(secret, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(stableStringify(JSON.parse(rawBody))));
    const signature = Buffer.from(digest).toString("base64");

    await expect(verifyBotWebhookSignature({ rawBody, webhookSecretBase64: secret, signature })).resolves.toBe(true);
    await expect(verifyBotWebhookSignature({ rawBody, webhookSecretBase64: secret, signature: `${signature}x` })).resolves.toBe(false);
  });
});
