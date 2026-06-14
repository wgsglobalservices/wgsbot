import { describe, expect, it } from "vitest";
import { applyReplacements, buildReplacements, parseEnvFile, setupCloudflare, validateAnswers, type SetupAnswers } from "./setup-cloudflare";

const rootConfig = [
  "{",
  "  // Self-hosting: replace every <PLACEHOLDER> below.",
  '  "name": "minutesbot",',
  '  "routes": [',
  '    { "pattern": "app.example.com", "custom_domain": true },',
  '    { "pattern": "api.example.com", "custom_domain": true },',
  '    { "pattern": "meeting.example.com", "custom_domain": true }',
  "  ],",
  '  "vars": {',
  '    "APP_BASE_URL": "https://app.example.com",',
  '    "API_BASE_URL": "https://api.example.com",',
  '    "BOT_WEBHOOK_BASE_URL": "https://meeting.example.com",',
  '    "BOT_API_BASE_URL": "https://meeting-api.example.com",',
  '    "DEFAULT_RECORDER_EMAIL": "notetaker@example.com",',
  '    "DEFAULT_SENDER_EMAIL": "notetaker@example.com"',
  "  },",
  '  "send_email": [{ "name": "SEND_EMAIL", "allowed_sender_addresses": ["notetaker@example.com"] }]',
  "}"
].join("\n");

const botConfig = [
  "{",
  '  "name": "minutesbot-meeting-bot",',
  '  "routes": [{ "pattern": "meeting-api.example.com", "custom_domain": true }],',
  '  "vars": {',
  '    "BOT_API_BASE_URL": "https://meeting-api.example.com",',
  '    "BOT_WEBHOOK_BASE_URL": "https://meeting.example.com"',
  "  }",
  "}"
].join("\n");

function createHarness() {
  const commands: string[] = [];
  const writes = new Map<string, string>();
  const messages: string[] = [];
  let ensured: { dryRun?: boolean } | undefined;

  const run = (args: string[]) =>
    setupCloudflare({
      args,
      env: {},
      runCommand: async (command, commandArgs) => {
        commands.push(`${command} ${commandArgs.join(" ")}`);
        return "ok";
      },
      ensureResources: async (options) => {
        ensured = { dryRun: options.dryRun };
      },
      readTextFile: async (path) => {
        if (writes.has(path)) return writes.get(path) as string;
        if (path === "wrangler.jsonc") return rootConfig;
        if (path === "deploy/bot-container/wrangler.jsonc") return botConfig;
        throw new Error(`no such file: ${path}`);
      },
      writeTextFile: async (path, contents) => {
        writes.set(path, contents);
      },
      isInteractive: false,
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

  return { commands, writes, messages, run, ensured: () => ensured };
}

describe("setupCloudflare", () => {
  const flags = [
    "--app-domain",
    "app.acme.com",
    "--api-domain",
    "api.acme.com",
    "--meeting-domain",
    "meeting.acme.com",
    "--meeting-api-domain",
    "meeting-api.acme.com",
    "--recorder-email",
    "notetaker@acme.com"
  ];

  it("patches domains and recorder email into both wrangler configs", async () => {
    const harness = createHarness();
    await harness.run(flags);

    const root = harness.writes.get("wrangler.jsonc") ?? "";
    expect(root).toContain('"APP_BASE_URL": "https://app.acme.com"');
    expect(root).toContain('"API_BASE_URL": "https://api.acme.com"');
    expect(root).toContain('"BOT_WEBHOOK_BASE_URL": "https://meeting.acme.com"');
    expect(root).toContain('"BOT_API_BASE_URL": "https://meeting-api.acme.com"');
    expect(root).toContain('"DEFAULT_RECORDER_EMAIL": "notetaker@acme.com"');
    expect(root).toContain('"allowed_sender_addresses": ["notetaker@acme.com"]');
    expect(root).not.toContain("example.com");
    // Comments survive the patch.
    expect(root).toContain("// Self-hosting: replace every <PLACEHOLDER> below.");

    const bot = harness.writes.get("deploy/bot-container/wrangler.jsonc") ?? "";
    expect(bot).toContain('"pattern": "meeting-api.acme.com"');
    expect(bot).toContain('"BOT_WEBHOOK_BASE_URL": "https://meeting.acme.com"');
    expect(bot).not.toContain("example.com");

    expect(harness.ensured()).toEqual({ dryRun: false });
  });

  it("validates prerequisites including wrangler auth", async () => {
    const harness = createHarness();
    await harness.run(flags);
    expect(harness.commands).toContain("wrangler whoami");
    expect(harness.commands).toContain("pnpm --version");
  });

  it("does not write configs in dry-run mode", async () => {
    const harness = createHarness();
    await harness.run([...flags, "--dry-run"]);

    expect(harness.writes.size).toBe(0);
    expect(harness.ensured()).toEqual({ dryRun: true });
    expect(harness.messages.some((m) => m.startsWith("Would replace"))).toBe(true);
  });

  it("never prints secret values, only the wrangler commands to set them", async () => {
    const harness = createHarness();
    await harness.run(flags);

    const output = harness.messages.join("\n");
    expect(output).toContain("wrangler secret put AI_API_KEY");
    expect(output).toContain("wrangler secret put SESSION_SECRET");
    expect(output).toContain("BOT_INTERNAL_TOKEN");
    expect(output).toContain("Email Routing");
  });

  it("fails fast when a prerequisite is missing", async () => {
    await expect(
      setupCloudflare({
        args: flags,
        env: {},
        runCommand: async (command, commandArgs) => {
          if (command === "wrangler" && commandArgs[0] === "whoami") throw new Error("You are not authenticated");
          return "ok";
        },
        ensureResources: async () => undefined,
        readTextFile: async () => rootConfig,
        writeTextFile: async () => undefined,
        isInteractive: false,
        log: () => undefined,
        error: () => undefined
      })
    ).rejects.toThrow("Prerequisite check failed for wrangler auth");
  });
});

describe("buildReplacements / applyReplacements", () => {
  it("does not let api.example.com clobber meeting-api.example.com", () => {
    const current: SetupAnswers = {
      appDomain: "app.example.com",
      apiDomain: "api.example.com",
      meetingDomain: "meeting.example.com",
      meetingApiDomain: "meeting-api.example.com",
      recorderEmail: "notetaker@example.com"
    };
    const next: SetupAnswers = { ...current, apiDomain: "api.acme.com" };

    const replaced = applyReplacements('"https://api.example.com" "https://meeting-api.example.com"', buildReplacements(current, next));

    expect(replaced).toBe('"https://api.acme.com" "https://meeting-api.example.com"');
  });
});

describe("validateAnswers", () => {
  const valid: SetupAnswers = {
    appDomain: "app.acme.com",
    apiDomain: "api.acme.com",
    meetingDomain: "meeting.acme.com",
    meetingApiDomain: "meeting-api.acme.com",
    recorderEmail: "notetaker@acme.com"
  };

  it("rejects URLs where a bare hostname is expected", () => {
    expect(() => validateAnswers({ ...valid, appDomain: "https://app.acme.com" })).toThrow("bare hostname");
  });

  it("rejects duplicate hostnames", () => {
    expect(() => validateAnswers({ ...valid, meetingApiDomain: "api.acme.com" })).toThrow("unique");
  });

  it("rejects invalid recorder emails", () => {
    expect(() => validateAnswers({ ...valid, recorderEmail: "not-an-email" })).toThrow("email address");
  });
});

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines, ignoring comments and quotes", () => {
    expect(parseEnvFile('# comment\nAPP_BASE_URL="https://app.acme.com"\nRECORDER_EMAIL=notetaker@acme.com\n\nBROKEN')).toEqual({
      APP_BASE_URL: "https://app.acme.com",
      RECORDER_EMAIL: "notetaker@acme.com"
    });
  });
});
