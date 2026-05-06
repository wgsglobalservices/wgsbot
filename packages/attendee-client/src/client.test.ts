import { afterEach, describe, expect, it, vi } from "vitest";
import { stableStringify } from "@minutesbot/shared";
import { AttendeeClient, verifyAttendeeWebhookSignature } from "./index";

describe("AttendeeClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates bots with token auth and normalized payload", async () => {
    const fetcher = vi.fn(async () => Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/x", state: "created" }));
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com/", apiKey: "secret", fetcher });

    const bot = await client.createBot({
      meetingUrl: "https://teams.microsoft.com/l/meetup-join/x",
      botName: "minutesbot",
      metadata: { minutesbot_meeting_id: "mtg_1" }
    });

    expect(bot.id).toBe("bot_1");
    expect(fetcher).toHaveBeenCalledWith(
      "https://attendee.company.com/api/v1/bots",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Token secret" }),
        body: expect.stringContaining("meeting_url")
      })
    );
  });

  it("normalizes rate limits into retryable typed errors", async () => {
    const fetcher = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com", apiKey: "secret", fetcher });

    await expect(client.getBot("bot_1")).rejects.toMatchObject({ code: "ATTENDEE_RATE_LIMITED", retryable: true });
  });

  it("retrieves bot recordings with content metadata", async () => {
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const fetcher = vi.fn(async () => new Response(audio, { headers: { "content-type": "audio/mp4", "content-length": "3" } }));
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com", apiKey: "secret", fetcher });

    const recording = await client.getBotRecording("bot_1");

    expect(fetcher).toHaveBeenCalledWith(
      "https://attendee.company.com/api/v1/bots/bot_1/recording",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Token secret" }) })
    );
    expect(recording.contentType).toBe("audio/mp4");
    expect(recording.sizeBytes).toBe(3);
    expect(new Uint8Array(recording.data)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("can force Attendee transcript retrieval", async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com", apiKey: "secret", fetcher });

    await client.getBotTranscript("bot_1", { force: true });

    expect(fetcher).toHaveBeenCalledWith(
      "https://attendee.company.com/api/v1/bots/bot_1/transcript?force=true",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Token secret" }) })
    );
  });

  it("does not force transcript retrieval by default", async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com", apiKey: "secret", fetcher });

    await client.getBotTranscript("bot_1");

    expect(fetcher).toHaveBeenCalledWith(
      "https://attendee.company.com/api/v1/bots/bot_1/transcript",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Token secret" }) })
    );
  });

  it("rejects JSON recording responses as unavailable media", async () => {
    const fetcher = vi.fn(async () => Response.json({ detail: "Recording is not available yet" }));
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com", apiKey: "secret", fetcher });

    await expect(client.getBotRecording("bot_1")).rejects.toMatchObject({
      code: "ATTENDEE_RECORDING_UNAVAILABLE",
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
    const client = new AttendeeClient({ baseUrl: "https://attendee.company.com", apiKey: "secret" });

    await expect(client.getBot("bot_1")).resolves.toMatchObject({ id: "bot_1" });
  });

  it("uses an authenticated bot lookup as hosted Attendee health preflight", async () => {
    const fetcher = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new AttendeeClient({ baseUrl: "https://app.attendee.dev", apiKey: "secret", fetcher });

    await expect(client.checkHealth()).resolves.toEqual({ ok: true, runtime: "attendee-hosted", missing: [] });
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.attendee.dev/api/v1/bots/minutesbot-preflight",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Token secret" })
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

    await expect(verifyAttendeeWebhookSignature({ rawBody, webhookSecretBase64: secret, signature })).resolves.toBe(true);
    await expect(verifyAttendeeWebhookSignature({ rawBody, webhookSecretBase64: secret, signature: `${signature}x` })).resolves.toBe(false);
  });
});
