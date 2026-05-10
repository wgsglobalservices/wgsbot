import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { readSettings, uploadBotImage, writeSettings } from "./settingsService";
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

describe("settings service", () => {
  it("derives AI API key status only from the Worker secret", async () => {
    const testEnv = env();

    await writeSettings(testEnv, {
      ...defaultSettings,
      ai: { ...defaultSettings.ai, apiKeyConfigured: true }
    });

    await expect(readSettings(testEnv)).resolves.toMatchObject({
      ai: { apiKeyConfigured: false }
    });
  });

  it("reports AI API key status when AI_API_KEY is configured in env", async () => {
    const testEnv = env({ AI_API_KEY: "sk-test" });

    await expect(readSettings(testEnv)).resolves.toMatchObject({
      ai: { apiKeyConfigured: true }
    });
  });

  it("normalizes legacy Attendee runtime URLs to the configured built-in bot runtime URL", async () => {
    const testEnv = env({ BOT_API_BASE_URL: "https://meeting-api.minutes.bot" });
    await writeSettings(testEnv, {
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        baseUrl: "https://attendee.minutes.bot"
      }
    });

    await expect(readSettings(testEnv)).resolves.toMatchObject({
      attendee: { baseUrl: "https://meeting-api.minutes.bot" }
    });
  });

  it("uploads bot images to R2 and persists only image metadata in settings", async () => {
    const put = vi.fn(async () => undefined);
    const testEnv = env({ ARTIFACTS: { put } as unknown as R2Bucket });

    const settings = await uploadBotImage(testEnv, {
      contentType: "image/png",
      data: "AQID",
      fileName: "minutesbot.png"
    });

    expect(put).toHaveBeenCalledWith(
      "settings/meeting-bot-image.png",
      new Uint8Array([1, 2, 3]),
      expect.objectContaining({ httpMetadata: { contentType: "image/png" } })
    );
    expect(settings.attendee.botImage).toMatchObject({
      r2Key: "settings/meeting-bot-image.png",
      contentType: "image/png",
      fileName: "minutesbot.png"
    });
    expect(JSON.stringify(settings)).not.toContain("AQID");
  });
});
