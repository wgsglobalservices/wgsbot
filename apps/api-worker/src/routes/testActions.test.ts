import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { app } from "../index";
import type { Env } from "../env";

class MemoryD1 {
  rows = new Map<string, string>();

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM settings")) {
          const key = this.values[0] as string;
          const value = db.rows.get(key);
          return value ? ({ key, value, updated_at: new Date().toISOString() } as T) : null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT OR REPLACE INTO settings")) {
          db.rows.set(this.values[0] as string, this.values[1] as string);
        }
        return { success: true };
      }
    };
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: new MemoryD1() as unknown as D1Database,
    ARTIFACTS: {} as R2Bucket,
    INVITE_QUEUE: { send: async () => undefined },
    SUMMARY_QUEUE: { send: async () => undefined },
    EMAIL_QUEUE: { send: async () => undefined },
    APP_BASE_URL: "https://minutesbot.example.com",
    API_BASE_URL: "https://minutesbot.example.com",
    BOT_API_BASE_URL: "https://meeting-bot.example.com",
    DEFAULT_RECORDER_EMAIL: "notetaker@example.com",
    DEFAULT_SENDER_EMAIL: "notetaker@example.com",
    ENVIRONMENT: "test",
    SESSION_SECRET: "test-secret",
    ...overrides
  };
}

async function post(path: string, testEnv: Env, body?: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    testEnv
  );
}

describe("admin test actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the dedicated meeting bot webhook URL separately from the API base URL", async () => {
    const response = await app.request(
      "/api/admin/status",
      { headers: { authorization: "Bearer test-secret" } },
      env({
        API_BASE_URL: "https://minutesbot.example.com",
        BOT_WEBHOOK_BASE_URL: "https://minutesbot-webhook.wgsglobal.app"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      webhookUrl: "https://minutesbot-webhook.wgsglobal.app/api/webhooks/bot"
    });
  });

  it("reports when the AI API key secret is not configured", async () => {
    const response = await post("/api/admin/test-ai", env());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "AI_API_KEY secret is not configured"
    });
  });

  it("tests the OpenAI-compatible AI provider without returning the secret", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );

    const response = await post("/api/admin/test-ai", env({ AI_API_KEY: "sk-secret" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "AI provider connection succeeded",
      provider: {
        type: defaultSettings.ai.provider,
        baseUrl: defaultSettings.ai.baseUrl,
        model: defaultSettings.ai.model
      }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0].init?.headers).toMatchObject({ authorization: "Bearer sk-secret" });
  });

  it("rejects invalid sample recap email recipients", async () => {
    const missing = await post("/api/admin/send-test-summary-email", env(), {});
    const invalid = await post("/api/admin/send-test-summary-email", env(), { to: "not-an-email" });

    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      message: "Enter a valid recipient email address"
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      ok: false,
      message: "Enter a valid recipient email address"
    });
  });

  it("sends a rendered sample recap email to the specified recipient without exposing secrets", async () => {
    const sent: unknown[] = [];
    const testEnv = env({
      SEND_EMAIL: {
        send: vi.fn(async (message: unknown) => {
          sent.push(message);
          return { id: "provider-message-1" };
        })
      },
      SMTP_PASSWORD: "smtp-secret"
    });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        email: {
          ...defaultSettings.email,
          provider: "cloudflare-email-service",
          senderEmail: "recaps@wgs.bot"
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/send-test-summary-email", testEnv, { to: "Reviewer@Example.COM" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Sample recap email sent",
      recipient: "reviewer@example.com",
      status: "sent",
      providerMessageId: "provider-message-1"
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: "WGS Notetaker <recaps@wgs.bot>",
      to: "reviewer@example.com",
      subject: "Meeting recap: Sample recap email"
    });
    expect(JSON.stringify(sent[0])).toContain("Generated by AI. Be sure to check for accuracy.");
    expect(JSON.stringify(sent[0])).toContain("Email Delivery Validation");
    expect(JSON.stringify(sent[0])).not.toContain("smtp-secret");
  });

  it("returns a provider failure when the sample recap email send throws", async () => {
    const testEnv = env({
      SEND_EMAIL: {
        send: vi.fn(async () => {
          throw new Error("provider unavailable");
        })
      }
    });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        email: {
          ...defaultSettings.email,
          provider: "cloudflare-email-service"
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/send-test-summary-email", testEnv, { to: "reviewer@example.com" });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "provider unavailable"
    });
  });

  it("calls the managed meeting bot runtime without requiring a user API key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn(async (url: string | URL | Request, init?: RequestInit) => {
          requests.push({ url: String(url), init });
          if (String(url).endsWith("/_ops/health")) return Response.json({ ok: true, runtime: "meeting-bot-container", missing: [] });
          if (String(url).endsWith("/minutesbot-preflight")) return new Response("not found", { status: 404 });
          return Response.json({ id: "bot_1", meeting_url: "https://teams.microsoft.com/l/meetup-join/test", state: "ready" });
        })
    );

    const response = await post("/api/admin/test-bot", env());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      message: "Meeting bot runtime connection succeeded",
      botRuntime: {
        baseUrl: defaultSettings.attendee.baseUrl
      }
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe(`${defaultSettings.attendee.baseUrl}/_ops/health`);
    expect(requests[1].url).toBe(`${defaultSettings.attendee.baseUrl}/api/v1/bots/minutesbot-preflight`);
    expect(requests[1].init?.headers).not.toHaveProperty("authorization");
  });

  it("uses deployment-managed internal auth when the runtime token is present", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        return String(url).endsWith("/_ops/health")
          ? Response.json({ ok: true, runtime: "meeting-bot-container", missing: [] })
          : new Response("not found", { status: 404 });
      })
    );

    const response = await post("/api/admin/test-bot", env({ BOT_INTERNAL_TOKEN: "managed-token" }));

    expect(response.status).toBe(200);
    expect(requests[1].init?.headers).toMatchObject({ authorization: "Bearer managed-token" });
  });

  it("returns a redacted meeting bot auth failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, runtime: "meeting-bot-container", missing: [] }))
        .mockResolvedValueOnce(new Response("nope bot-secret", { status: 401 }))
    );

    const response = await post("/api/admin/test-bot", env({ BOT_INTERNAL_TOKEN: "managed-token" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "BOT_AUTH_FAILED: Meeting bot request failed with 401"
    });
  });

  it("returns meeting bot health failures with missing runtime settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, runtime: "meeting-bot-container", missing: ["TEAMS_RECORDER_PASSWORD", "ffmpeg"] }), {
          status: 503,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const testEnv = env({ BOT_API_BASE_URL: "https://meeting-bot.wgsglobal.app" });
    await testEnv.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").bind(
      "app",
      JSON.stringify({
        ...defaultSettings,
        attendee: {
          ...defaultSettings.attendee,
          baseUrl: "https://meeting-bot.wgsglobal.app"
        }
      }),
      new Date().toISOString()
    ).run();

    const response = await post("/api/admin/test-bot", testEnv);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      message: "BOT_UNHEALTHY: Meeting bot health check failed: missing TEAMS_RECORDER_PASSWORD, ffmpeg"
    });
  });
});
