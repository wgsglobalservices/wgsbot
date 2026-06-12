import { describe, expect, it } from "vitest";
import { deployMinutesbot, parseDeployEnvironment } from "./deploy-minutesbot";

describe("deployMinutesbot", () => {
  it("ensures production queues before deploying production", async () => {
    const events: string[] = [];

    await deployMinutesbot({
      environment: "production",
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["ensure:production", "wrangler deploy"]);
  });

  it("ensures staging queues before deploying staging when env.staging is configured", async () => {
    const events: string[] = [];

    await deployMinutesbot({
      environment: "staging",
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      readConfig: async () => JSON.stringify({ env: { staging: { d1_databases: [] } } }),
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["ensure:staging", "wrangler deploy --env staging"]);
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
        readConfig: async () => ['{', '  // no env block configured', '  "name": "minutesbot"', "}"].join("\n"),
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
