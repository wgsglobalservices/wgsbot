import { describe, expect, it } from "vitest";
import { deployBotContainer } from "./deploy-bot-container";

describe("deployBotContainer", () => {
  it("generates a fresh bot container config before deploying", async () => {
    const commands: string[] = [];
    const writes = new Map<string, string>();

    await deployBotContainer({
      env: sampleEnv({ BOT_CONTAINER_INSTANCE_ID: "production-stale-container", BOT_RUNTIME_VERSION: "stale-version" }),
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        if (command === "git") return "fresh-sha";
      },
      writeTextFile: async (path, contents) => {
        writes.set(path, contents);
      },
      makeDir: async () => undefined,
      log: () => undefined
    });

    const config = writes.get(".wrangler/oneshot-bot.jsonc") ?? "";
    expect(config).toContain('"BOT_RUNTIME_VERSION": "fresh-sha"');
    expect(config).not.toContain("stale-version");
    expect(config).not.toContain("production-stale-container");
    expect(config).toMatch(/"BOT_CONTAINER_INSTANCE_ID": "production-\d{14}-[0-9a-f]{8}"/);
    expect(commands).toContain("wrangler deploy --config .wrangler/oneshot-bot.jsonc");
  });
});

function sampleEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_ENV: "production",
    APP_BASE_URL: "https://app.minutes.bot",
    API_BASE_URL: "https://api.minutes.bot",
    BOT_WEBHOOK_BASE_URL: "https://meeting.minutes.bot",
    BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
    BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
    CLOUDFLARE_ACCESS_AUD: "access-aud",
    CLOUDFLARE_ACCESS_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    DEFAULT_RECORDER_EMAIL: "notetaker@minutes.bot",
    DEFAULT_SENDER_EMAIL: "notetaker@minutes.bot",
    OPENROUTER_API_KEY: "openrouter-key",
    SESSION_SECRET: "session-secret",
    ...overrides
  };
}
