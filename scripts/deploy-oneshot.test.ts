import { describe, expect, it } from "vitest";
import {
  buildBotWranglerConfig,
  buildMinutesbotWranglerConfig,
  deployOneshot,
  parseEnvFile,
  parseOneshotArgs,
  validateOneshotEnv
} from "./deploy-oneshot";

describe("parseOneshotArgs", () => {
  it("defaults to production and supports dry-run", () => {
    expect(parseOneshotArgs(["node", "deploy-oneshot.ts", "--dry-run"])).toEqual({ environment: "production", dryRun: true });
  });

  it("fails unsupported environments", () => {
    expect(() => parseOneshotArgs(["node", "deploy-oneshot.ts", "--env", "preview"])).toThrow("Unsupported oneshot deploy environment");
  });
});

describe("parseEnvFile", () => {
  it("parses simple dotenv files without leaking comments into values", () => {
    expect(parseEnvFile("# comment\nAPP_BASE_URL=https://app.minutes.bot\nAPI_BASE_URL=https://api.minutes.bot\nSESSION_SECRET='secret'\n")).toEqual({
      APP_BASE_URL: "https://app.minutes.bot",
      API_BASE_URL: "https://api.minutes.bot",
      SESSION_SECRET: "secret"
    });
  });
});

describe("validateOneshotEnv", () => {
  it("reports missing required values before deploying", () => {
    expect(() => validateOneshotEnv({ CLOUDFLARE_ENV: "production" }, "production")).toThrow(
      "Missing required .env.oneshot values"
    );
  });

  it("requires CLOUDFLARE_ENV to match the selected deploy environment", () => {
    const env = sampleEnv({ CLOUDFLARE_ENV: "staging" });
    expect(() => validateOneshotEnv(env, "production")).toThrow("CLOUDFLARE_ENV must match --env");
  });

  it("requires production base URLs to use the configured minutes.bot hosts", () => {
    expect(() => validateOneshotEnv(sampleEnv({ API_BASE_URL: "https://wrong.example.com" }), "production")).toThrow(
      "API_BASE_URL must use api.minutes.bot"
    );
    expect(() => validateOneshotEnv(sampleEnv({ BOT_WEBHOOK_BASE_URL: "https://wrong.example.com" }), "production")).toThrow(
      "BOT_WEBHOOK_BASE_URL must use meeting.minutes.bot"
    );
    expect(() => validateOneshotEnv(sampleEnv({ BOT_API_BASE_URL: "https://wrong.example.com" }), "production")).toThrow(
      "BOT_API_BASE_URL must use meeting-api.minutes.bot"
    );
  });
});

describe("build oneshot Wrangler configs", () => {
  it("uses env-provided routes and removes legacy customer-specific defaults", () => {
    const minutesbotConfig = buildMinutesbotWranglerConfig(sampleEnv(), "production");
    const botConfig = buildBotWranglerConfig(sampleEnv({ BOT_CONTAINER_INSTANCE_ID: "production-test-container" }));

    expect(minutesbotConfig).toContain("app.minutes.bot");
    expect(minutesbotConfig).toContain("api.minutes.bot");
    expect(minutesbotConfig).toContain("meeting.minutes.bot");
    expect(minutesbotConfig).toContain("CLOUDFLARE_ACCESS_AUD");
    expect(minutesbotConfig).toContain("CLOUDFLARE_ACCESS_JWKS_URL");
    expect(minutesbotConfig).not.toContain("CLOUDFLARE_ACCESS_ISSUER");
    expect(botConfig).toContain("meeting-api.minutes.bot");
    expect(botConfig).toContain("meeting.minutes.bot");
    expect(botConfig).toContain('"BOT_CONTAINER_INSTANCE_ID": "production-test-container"');
    expect(botConfig).toContain('"BOT_RUNTIME_VERSION": "runtime-test-version"');
    expect(botConfig).toContain('"binding": "ARTIFACTS"');
    expect(botConfig).toContain('"bucket_name": "minutesbot-artifacts"');
    expect(botConfig).toContain('"max_instances": 6');
    expect(minutesbotConfig).toContain('"binding": "BOT_RUNTIME"');
    expect(minutesbotConfig).toContain('"service": "minutesbot-meeting-bot"');
    expect(botConfig).toContain("../Dockerfile.bot");
    expect(botConfig).not.toContain(".attendee/upstream");
    expect(botConfig).not.toContain("DJANGO_SETTINGS_MODULE");
    expect(minutesbotConfig).toContain('"workers_dev": false');
    expect(JSON.parse(minutesbotConfig).d1_databases[0].migrations_dir).toBe("../migrations");
    expect(botConfig).toContain('"workers_dev": false');
    expect((minutesbotConfig.match(/"custom_domain": true/g) ?? []).length).toBe(3);
    expect(minutesbotConfig).toContain('"producers"');
    expect(minutesbotConfig).toContain('"consumers"');
    expect(minutesbotConfig).toContain('"queue": "minutesbot-invites"');
    expect(minutesbotConfig).toContain('"queue": "minutesbot-summaries"');
    expect(minutesbotConfig).not.toContain("notes.company.com");
    expect(minutesbotConfig).not.toContain("api.company.com");
    expect(minutesbotConfig).not.toContain("webhook.company.com");
    expect(`${minutesbotConfig}\n${botConfig}`).not.toContain("legacy-customer");
    expect(`${minutesbotConfig}\n${botConfig}`).not.toContain("customer.example");
  });
});

describe("deployOneshot", () => {
  it("dry-runs without executing commands or writing config", async () => {
    const commands: string[] = [];
    const writes = new Map<string, string>();
    const messages: string[] = [];

    await deployOneshot({
      env: sampleEnv(),
      dryRun: true,
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
      },
      runCommandWithInput: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
      },
      readTextFile: async (path) => {
        const contents = writes.get(path);
        if (!contents) throw new Error(`missing ${path}`);
        return contents;
      },
      writeTextFile: async (path, contents) => {
        writes.set(path, contents);
      },
      log: (message) => messages.push(message),
      error: () => undefined
    });

    expect(commands).toEqual([]);
    expect([...writes.keys()]).toEqual([]);
    expect(messages).toContain("[dry-run] deploy minutesbot Worker");
    expect(messages).toContain("[dry-run] put meeting bot container secret BOT_INTERNAL_TOKEN");
    expect(messages).not.toContain("[dry-run] put meeting bot container secret TEAMS_RECORDER_PASSWORD");
    expect(messages).not.toContain("[dry-run] put meeting bot container secret BOT_API_KEY");
  });

  it("runs the deploy flow with generated configs, secrets, health checks, and smoke checks", async () => {
    const commands: string[] = [];
    const secrets: string[] = [];
    const fetches: string[] = [];
    const writes = new Map<string, string>();

    await deployOneshot({
      env: sampleEnv(),
      runCommand: async (command, args) => {
        commands.push(`${command} ${args.join(" ")}`);
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "db-id" }]);
      },
      runCommandWithInput: async (command, args) => {
        secrets.push(`${command} ${args.join(" ")}`);
      },
      fetchHealth: async (url, init) => {
        fetches.push(`${init?.method ?? "GET"} ${url.toString()}`);
        return Response.json({ ok: true });
      },
      readTextFile: async (path) => {
        const contents = writes.get(path);
        if (!contents) throw new Error(`missing ${path}`);
        return contents;
      },
      makeDir: async () => undefined,
      writeTextFile: async (path, contents) => {
        writes.set(path, contents);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(commands).toContain("pnpm --version");
    expect(commands).toContain("wrangler whoami");
    expect(commands).toContain("docker info");
    expect(commands).not.toContain("pnpm attendee:prepare");
    expect(commands).toContain("wrangler deploy --config .wrangler/oneshot-bot.jsonc");
    expect(commands).toContain("pnpm run build");
    expect(commands).toContain("wrangler deploy --config .wrangler/oneshot-minutesbot.jsonc");
    expect(secrets).toContain("wrangler secret put BOT_INTERNAL_TOKEN --config .wrangler/oneshot-bot.jsonc");
    expect(secrets).not.toContain("wrangler secret put TEAMS_RECORDER_PASSWORD --config .wrangler/oneshot-bot.jsonc");
    expect(secrets).toContain("wrangler secret put BOT_INTERNAL_TOKEN --config .wrangler/oneshot-minutesbot.jsonc");
    expect(secrets).not.toContain("wrangler secret put BOT_API_KEY --config .wrangler/oneshot-bot.jsonc");
    expect(secrets).not.toContain("wrangler secret put BOT_WEBHOOK_SECRET --config .wrangler/oneshot-minutesbot.jsonc");
    expect(fetches).toContain("GET https://meeting-api.minutes.bot/_ops/health");
    expect(fetches).toContain("GET https://api.minutes.bot/api/health");
    expect(fetches).toContain("POST https://app.minutes.bot/api/admin/test-r2");
    expect(fetches).toContain("POST https://app.minutes.bot/api/admin/test-bot");
    expect(fetches).toContain("POST https://meeting.minutes.bot/api/webhooks/bot");
    expect([...writes.keys()]).toContain(".wrangler/oneshot-minutesbot.jsonc");
    expect([...writes.keys()]).toContain(".wrangler/oneshot-bot.jsonc");
    expect(writes.get(".wrangler/oneshot-bot.jsonc")).toMatch(/"BOT_CONTAINER_INSTANCE_ID": "production-\d{14}-[0-9a-f]{8}"/);
  });

  it("generates a fresh bot container instance id even when the env file has an old one", async () => {
    const writes = new Map<string, string>();

    await deployOneshot({
      env: sampleEnv({ BOT_CONTAINER_INSTANCE_ID: "production-stale-container" }),
      runCommand: async (command, args) => {
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "db-id" }]);
      },
      runCommandWithInput: async () => undefined,
      fetchHealth: async () => Response.json({ ok: true }),
      readTextFile: async (path) => {
        const contents = writes.get(path);
        if (!contents) throw new Error(`missing ${path}`);
        return contents;
      },
      makeDir: async () => undefined,
      writeTextFile: async (path, contents) => {
        writes.set(path, contents);
      },
      log: () => undefined,
      error: () => undefined
    });

    const botConfig = writes.get(".wrangler/oneshot-bot.jsonc") ?? "";
    expect(botConfig).not.toContain("production-stale-container");
    expect(botConfig).toMatch(/"BOT_CONTAINER_INSTANCE_ID": "production-\d{14}-[0-9a-f]{8}"/);
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
    DEFAULT_RECORDER_EMAIL: "notetaker@minutes.bot",
    DEFAULT_SENDER_EMAIL: "notetaker@minutes.bot",
    OPENROUTER_API_KEY: "openrouter-key",
    SESSION_SECRET: "session-secret",
    CLOUDFLARE_ACCESS_AUD: "access-aud",
    CLOUDFLARE_ACCESS_JWKS_URL: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    BOT_RUNTIME_VERSION: "runtime-test-version",
    ...overrides
  };
}
