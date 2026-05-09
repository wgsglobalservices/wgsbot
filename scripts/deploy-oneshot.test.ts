import { describe, expect, it } from "vitest";
import {
  buildAttendeeWranglerConfig,
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
    expect(parseEnvFile("# comment\nAPP_BASE_URL=https://admin.minutes.bot\nAPI_BASE_URL=https://api.minutes.bot\nSESSION_SECRET='secret'\n")).toEqual({
      APP_BASE_URL: "https://admin.minutes.bot",
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
  });
});

describe("build oneshot Wrangler configs", () => {
  it("uses env-provided routes and removes WGS-specific defaults", () => {
    const minutesbotConfig = buildMinutesbotWranglerConfig(sampleEnv(), "production");
    const attendeeConfig = buildAttendeeWranglerConfig(sampleEnv());

    expect(minutesbotConfig).toContain("app.minutes.bot");
    expect(minutesbotConfig).toContain("admin.minutes.bot");
    expect(minutesbotConfig).toContain("api.minutes.bot");
    expect(minutesbotConfig).toContain("13f67694a98579897f6175043bb595df17afdfd5129d44c33e8b937b5576ae71");
    expect(attendeeConfig).toContain("attendee.company.com");
    expect(minutesbotConfig).toContain('"workers_dev": false');
    expect(attendeeConfig).toContain('"workers_dev": false');
    expect((minutesbotConfig.match(/"custom_domain": true/g) ?? []).length).toBe(1);
    expect(minutesbotConfig).toContain('"producers"');
    expect(minutesbotConfig).not.toContain('"consumers"');
    expect(minutesbotConfig).not.toContain("notes.company.com");
    expect(minutesbotConfig).not.toContain("api.company.com");
    expect(minutesbotConfig).not.toContain("webhook.company.com");
    expect(`${minutesbotConfig}\n${attendeeConfig}`).not.toContain("wgsglobal");
    expect(`${minutesbotConfig}\n${attendeeConfig}`).not.toContain("wgs.bot");
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
    expect(messages).toContain("[dry-run] put Attendee container secret DATABASE_URL");
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
    expect(commands).toContain("pnpm attendee:prepare");
    expect(commands).toContain("wrangler deploy --config .wrangler/oneshot-attendee.jsonc");
    expect(commands).toContain("pnpm run build");
    expect(commands).toContain("wrangler deploy --config .wrangler/oneshot-minutesbot.jsonc");
    expect(secrets).toContain("wrangler secret put DATABASE_URL --config .wrangler/oneshot-attendee.jsonc");
    expect(secrets).toContain("wrangler secret put ATTENDEE_API_KEY --config .wrangler/oneshot-minutesbot.jsonc");
    expect(fetches).toContain("GET https://attendee.company.com/_ops/health");
    expect(fetches).toContain("POST https://attendee.company.com/_ops/start-workers");
    expect(fetches).toContain("GET https://api.minutes.bot/api/health");
    expect(fetches).toContain("POST https://api.minutes.bot/api/admin/test-r2");
    expect(fetches).toContain("POST https://api.minutes.bot/api/admin/test-attendee");
    expect(fetches).toContain("POST https://admin.minutes.bot/api/webhooks/attendee");
    expect([...writes.keys()]).toContain(".wrangler/oneshot-minutesbot.jsonc");
    expect([...writes.keys()]).toContain(".wrangler/oneshot-attendee.jsonc");
  });
});

function sampleEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CLOUDFLARE_ACCOUNT_ID: "account-id",
    CLOUDFLARE_ENV: "production",
    APP_BASE_URL: "https://admin.minutes.bot",
    API_BASE_URL: "https://api.minutes.bot",
    ATTENDEE_WEBHOOK_BASE_URL: "https://admin.minutes.bot",
    ATTENDEE_API_BASE_URL: "https://attendee.company.com",
    ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME: "minutesbot-artifacts",
    DEFAULT_RECORDER_EMAIL: "notetaker@minutes.bot",
    DEFAULT_SENDER_EMAIL: "notetaker@minutes.bot",
    DATABASE_URL: "postgres://user:pass@db.example.com:5432/attendee",
    REDIS_URL: "redis://redis.example.com:6379",
    DJANGO_SECRET_KEY: "django-secret",
    CREDENTIALS_ENCRYPTION_KEY: "credentials-secret",
    R2_ACCOUNT_ID: "r2-account",
    R2_ACCESS_KEY_ID: "r2-access",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    R2_ENDPOINT_URL: "https://r2-account.r2.cloudflarestorage.com",
    R2_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
    ATTENDEE_API_KEY: "attendee-api-key",
    ATTENDEE_WEBHOOK_SECRET: Buffer.from("webhook-secret").toString("base64"),
    DEEPGRAM_API_KEY: "deepgram-key",
    OPENROUTER_API_KEY: "openrouter-key",
    SESSION_SECRET: "session-secret",
    CLOUDFLARE_ACCESS_AUD: "13f67694a98579897f6175043bb595df17afdfd5129d44c33e8b937b5576ae71",
    CLOUDFLARE_ACCESS_JWKS_URL: "https://esau.cloudflareaccess.com/cdn-cgi/access/certs",
    CLOUDFLARE_ACCESS_ISSUER: "https://esau.cloudflareaccess.com",
    ZOOM_CLIENT_ID: "zoom-client-id",
    ZOOM_CLIENT_SECRET: "zoom-client-secret",
    ...overrides
  };
}
