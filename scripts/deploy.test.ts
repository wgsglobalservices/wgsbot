import { describe, expect, it } from "vitest";
import { assertNoPlaceholders, deployMinutesbot, parseDeployEnvironment } from "./deploy-minutesbot";

const readyConfig = JSON.stringify({
  vars: {
    API_BASE_URL: "https://api.minutes.bot",
    BOT_API_BASE_URL: "https://meeting-api.minutes.bot"
  },
  d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "real-db-id" }]
});

describe("deployMinutesbot", () => {
  it("provisions, validates, builds, deploys, then smoke checks", async () => {
    const events: string[] = [];

    await deployMinutesbot({
      environment: "production",
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      runHealthCheck: async (env) => {
        events.push(`check:${env.API_BASE_URL}:${env.BOT_API_BASE_URL}`);
        return 0;
      },
      readConfig: async () => readyConfig,
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual([
      "ensure:production",
      "pnpm run build",
      "wrangler deploy",
      "check:https://api.minutes.bot:https://meeting-api.minutes.bot"
    ]);
  });

  it("refuses to deploy while wrangler.jsonc still contains placeholders", async () => {
    const events: string[] = [];
    const placeholderConfig = JSON.stringify({
      vars: { API_BASE_URL: "https://api.example.com" },
      d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "<D1_DATABASE_ID>" }]
    });

    await expect(
      deployMinutesbot({
        environment: "production",
        ensureResources: async () => {
          events.push("ensure");
        },
        runCommand: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
        },
        runBuildCommand: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
        },
        runHealthCheck: async () => 0,
        readConfig: async () => placeholderConfig,
        log: () => undefined,
        error: () => undefined
      })
    ).rejects.toThrow("placeholder values");

    // Provisioning runs (it patches the database id), but nothing is built or deployed.
    expect(events).toEqual(["ensure"]);
  });

  it("fails the deploy when post-deploy health checks fail", async () => {
    const events: string[] = [];

    await expect(
      deployMinutesbot({
        environment: "production",
        ensureResources: async () => {
          events.push("ensure");
        },
        runCommand: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
        },
        runBuildCommand: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
        },
        runHealthCheck: async () => 1,
        readConfig: async () => readyConfig,
        log: () => undefined,
        error: () => undefined
      })
    ).rejects.toThrow("Post-deploy health checks failed");

    expect(events).toEqual(["ensure", "pnpm run build", "wrangler deploy"]);
  });

  it("deploys staging with --env when env.staging is configured", async () => {
    const events: string[] = [];
    const stagingConfig = JSON.stringify({
      vars: { API_BASE_URL: "https://api.staging.minutes.bot" },
      env: { staging: { d1_databases: [] } }
    });

    await deployMinutesbot({
      environment: "staging",
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      runHealthCheck: async () => 0,
      readConfig: async () => stagingConfig,
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["ensure:staging", "pnpm run build", "wrangler deploy --env staging"]);
  });

  it("fails closed when wrangler.jsonc has no env.staging block", async () => {
    const events: string[] = [];

    await expect(
      deployMinutesbot({
        environment: "staging",
        ensureResources: async ({ environment }) => {
          events.push(`ensure:${environment}`);
        },
        runCommand: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
        },
        runHealthCheck: async () => 0,
        readConfig: async () => ["{", "  // no env block configured", '  "name": "minutesbot"', "}"].join("\n"),
        log: () => undefined,
        error: () => undefined
      })
    ).rejects.toThrow('wrangler.jsonc has no "env.staging" block');

    expect(events).toEqual([]);
  });

  it("fails invalid environments before deployment", async () => {
    expect(() => parseDeployEnvironment(["node", "deploy-minutesbot.ts", "--env", "preview"])).toThrow(
      "Unsupported deploy environment"
    );
  });
});

describe("assertNoPlaceholders", () => {
  it("accepts a fully configured file and ignores placeholders in comments", () => {
    expect(() => assertNoPlaceholders('{\n  // replace <D1_DATABASE_ID> via setup\n  "name": "minutesbot"\n}')).not.toThrow();
  });

  it("names every remaining placeholder", () => {
    expect(() => assertNoPlaceholders('{ "id": "<D1_DATABASE_ID>", "url": "https://app.example.com" }')).toThrow(
      /<D1_DATABASE_ID>.*app\.example\.com/
    );
  });
});
