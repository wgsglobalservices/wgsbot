import { describe, expect, it } from "vitest";
import { buildMinutesbot, parseBuildEnvironment } from "./build-minutesbot";

describe("buildMinutesbot", () => {
  it("skips Cloudflare provisioning for local builds", async () => {
    const events: string[] = [];

    await buildMinutesbot({
      env: {},
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      ensureBotRuntimeWorker: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
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

    await buildMinutesbot({
      env: { WORKERS_CI: "1" },
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      ensureBotRuntimeWorker: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual([
      "ensure:production",
      "wrangler deploy --config deploy/bot-container/wrangler.jsonc",
      "pnpm run build:workspace"
    ]);
  });

  it("ensures staging queues before Workers Builds workspace build when requested", async () => {
    const events: string[] = [];

    await buildMinutesbot({
      env: { WORKERS_CI: "1", MINUTESBOT_DEPLOY_ENV: "staging" },
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      ensureBotRuntimeWorker: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      runBuildCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual([
      "ensure:staging",
      "wrangler deploy --config deploy/bot-container/wrangler.jsonc",
      "pnpm run build:workspace"
    ]);
  });

  it("fails invalid deploy environments before provisioning or building", async () => {
    const events: string[] = [];

    await expect(
      buildMinutesbot({
        env: { WORKERS_CI: "1", MINUTESBOT_DEPLOY_ENV: "preview" },
        ensureResources: async ({ environment }) => {
          events.push(`ensure:${environment}`);
        },
        ensureBotRuntimeWorker: async (command, args) => {
          events.push(`${command} ${args.join(" ")}`);
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
