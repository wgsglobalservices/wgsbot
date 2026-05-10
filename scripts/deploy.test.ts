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

    expect(events).toEqual(["ensure:production", "wrangler deploy --env production"]);
  });

  it("ensures staging queues before deploying staging", async () => {
    const events: string[] = [];

    await deployMinutesbot({
      environment: "staging",
      ensureResources: async ({ environment }) => {
        events.push(`ensure:${environment}`);
      },
      runCommand: async (command, args) => {
        events.push(`${command} ${args.join(" ")}`);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(events).toEqual(["ensure:staging", "wrangler deploy --env staging"]);
  });

  it("fails invalid environments before deployment", async () => {
    expect(() => parseDeployEnvironment(["node", "deploy-minutesbot.ts", "--env", "preview"])).toThrow(
      "Unsupported deploy environment"
    );
  });
});
