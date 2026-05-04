import { describe, expect, it } from "vitest";
import { ensureCloudflareResources } from "./ensure-cloudflare-resources";

describe("ensureCloudflareResources", () => {
  it("creates only missing queues", async () => {
    const commands: string[][] = [];
    const existingQueues = new Set(["minutesbot-invites"]);

    await ensureCloudflareResources({
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        const action = args[1];
        const queueName = args[2];
        if (action === "info" && existingQueues.has(queueName)) return;
        if (action === "info") throw new Error(`Queue ${queueName} does not exist`);
        if (action === "create") {
          existingQueues.add(queueName);
          return;
        }
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(commands).toEqual([
      ["wrangler", "queues", "info", "minutesbot-invites"],
      ["wrangler", "queues", "info", "minutesbot-summaries"],
      ["wrangler", "queues", "create", "minutesbot-summaries"],
      ["wrangler", "queues", "info", "minutesbot-email"],
      ["wrangler", "queues", "create", "minutesbot-email"]
    ]);
  });

  it("fails fast when creating a missing queue fails", async () => {
    const commands: string[][] = [];
    const errors: string[] = [];

    await expect(
      ensureCloudflareResources({
        runCommand: async (command, args) => {
          commands.push([command, ...args]);
          if (args[1] === "info") throw new Error("not found");
          throw new Error("authentication failed");
        },
        log: () => undefined,
        error: (message) => errors.push(message)
      })
    ).rejects.toThrow("authentication failed");

    expect(commands).toEqual([
      ["wrangler", "queues", "info", "minutesbot-invites"],
      ["wrangler", "queues", "create", "minutesbot-invites"]
    ]);
    expect(errors).toContain("Failed to create Cloudflare Queue minutesbot-invites: authentication failed");
  });
});
