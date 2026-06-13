import { describe, expect, it } from "vitest";
import { buildMinutesbot, parseBuildEnvironment } from "./build-minutesbot";

const configuredConfig = JSON.stringify({
  routes: [
    { pattern: "app.minutes.bot", custom_domain: true },
    { pattern: "api.minutes.bot", custom_domain: true },
    { pattern: "meeting.minutes.bot", custom_domain: true }
  ],
  vars: {
    APP_BASE_URL: "https://app.minutes.bot",
    API_BASE_URL: "https://api.minutes.bot",
    BOT_WEBHOOK_BASE_URL: "https://meeting.minutes.bot",
    BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
    DEFAULT_RECORDER_EMAIL: "notetaker@minutes.bot",
    DEFAULT_SENDER_EMAIL: "notetaker@minutes.bot"
  },
  d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "real-db-id" }]
});

const placeholderConfig = JSON.stringify({
  routes: [
    { pattern: "app.example.com", custom_domain: true },
    { pattern: "api.example.com", custom_domain: true },
    { pattern: "meeting.example.com", custom_domain: true }
  ],
  vars: {
    APP_BASE_URL: "https://app.example.com",
    API_BASE_URL: "https://api.example.com",
    BOT_WEBHOOK_BASE_URL: "https://meeting.example.com",
    BOT_API_BASE_URL: "https://meeting-api.example.com",
    DEFAULT_RECORDER_EMAIL: "notetaker@example.com",
    DEFAULT_SENDER_EMAIL: "notetaker@example.com"
  },
  d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "real-db-id" }],
  send_email: [{ name: "SEND_EMAIL", allowed_sender_addresses: ["notetaker@example.com"] }]
});

function createConfigHarness(initialConfig: string) {
  let configText = initialConfig;
  return {
    readConfig: async () => configText,
    writeConfig: async (_path: string, contents: string) => {
      configText = contents;
    },
    configText: () => configText
  };
}

describe("buildMinutesbot", () => {
  it("skips Cloudflare provisioning for local builds", async () => {
    const events: string[] = [];

    await buildMinutesbot({
      env: {},
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["pnpm run build:workspace"]);
  });

  it("ensures production queues before Workers Builds workspace build", async () => {
    const events: string[] = [];
    const config = createConfigHarness(configuredConfig);

    await buildMinutesbot({
      env: { WORKERS_CI: "1" },
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["ensure:production", "pnpm run build:workspace"]);
  });

  it("ensures staging queues before Workers Builds workspace build when requested", async () => {
    const events: string[] = [];
    const config = createConfigHarness(configuredConfig);

    await buildMinutesbot({
      env: { WORKERS_CI: "1", MINUTESBOT_DEPLOY_ENV: "staging" },
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["ensure:staging", "pnpm run build:workspace"]);
  });

  it("patches checked-in placeholder domains from Workers Builds environment variables", async () => {
    const events: string[] = [];
    const messages: string[] = [];
    const config = createConfigHarness(placeholderConfig);

    await buildMinutesbot({
      env: {
        WORKERS_CI: "1",
        APP_BASE_URL: "https://app.minutes.bot",
        API_BASE_URL: "https://api.minutes.bot",
        BOT_WEBHOOK_BASE_URL: "https://meeting.minutes.bot",
        BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
        RECORDER_EMAIL: "notetaker@minutes.bot"
      },
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      log: (message) => messages.push(message),
      error: () => undefined
    });

    expect(events).toEqual(["ensure:production", "pnpm run build:workspace"]);
    expect(messages).toContain("Patched wrangler.jsonc for Cloudflare Workers Builds deployment.");
    expect(config.configText()).toContain("app.minutes.bot");
    expect(config.configText()).toContain("notetaker@minutes.bot");
    expect(config.configText()).not.toContain("example.com");
  });

  it("defaults Workers Builds placeholder domains to minutes.bot", async () => {
    const events: string[] = [];
    const messages: string[] = [];
    const config = createConfigHarness(placeholderConfig);

    await buildMinutesbot({
      env: { WORKERS_CI: "1" },
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      log: (message) => messages.push(message),
      error: () => undefined
    });

    expect(events).toEqual(["ensure:production", "pnpm run build:workspace"]);
    expect(messages).toContain("Patched wrangler.jsonc for Cloudflare Workers Builds deployment.");
    expect(config.configText()).toContain("app.minutes.bot");
    expect(config.configText()).toContain("api.minutes.bot");
    expect(config.configText()).toContain("meeting.minutes.bot");
    expect(config.configText()).toContain("meeting-api.minutes.bot");
    expect(config.configText()).toContain("notetaker@minutes.bot");
    expect(config.configText()).not.toContain("example.com");
  });

  it("can derive Workers Builds hostnames from a custom MINUTESBOT_DOMAIN", async () => {
    const config = createConfigHarness(placeholderConfig);

    await buildMinutesbot({
      env: { WORKERS_CI: "1", MINUTESBOT_DOMAIN: "acme.com" },
      ensureResources: async () => undefined,
      runBuildCommand: async () => undefined,
      readConfig: config.readConfig,
      writeConfig: config.writeConfig,
      log: () => undefined,
      error: () => undefined
    });

    expect(config.configText()).toContain("app.acme.com");
    expect(config.configText()).toContain("api.acme.com");
    expect(config.configText()).toContain("meeting.acme.com");
    expect(config.configText()).toContain("meeting-api.acme.com");
    expect(config.configText()).toContain("notetaker@acme.com");
    expect(config.configText()).not.toContain("example.com");
  });

  it("fails invalid deploy environments before provisioning or building", async () => {
    const events: string[] = [];

    await expect(
      buildMinutesbot({
        env: { WORKERS_CI: "1", MINUTESBOT_DEPLOY_ENV: "preview" },
        ensureResources: async ({ environment }) => {
          events.push(`ensure:${environment}`);
        },
        runBuildCommand: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
        },
        log: () => undefined,
        error: () => undefined
      })
    ).rejects.toThrow("Unsupported build deploy environment");

    expect(events).toEqual([]);
  });
});

describe("parseBuildEnvironment", () => {
  it("defaults Workers Builds deployments to production", () => {
    expect(parseBuildEnvironment({ WORKERS_CI: "1" })).toBe("production");
  });
});
