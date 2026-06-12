import { describe, expect, it } from "vitest";
import { ensureCloudflareResources, stripJsonComments } from "./ensure-cloudflare-resources";

describe("ensureCloudflareResources", () => {
  const existingConfig = JSON.stringify(
    {
      d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "stale-db-id" }],
      env: {
        production: {
          d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "stale-db-id" }]
        }
      }
    },
    null,
    2
  );

  it("creates only missing queues after ensuring durable storage", async () => {
    const commands: string[][] = [];
    const existingQueues = new Set(["minutesbot-invites"]);
    let writtenConfig = "";

    await ensureCloudflareResources({
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "real-db-id" }]);
        if (args[0] === "d1" && args[1] === "migrations") return;
        if (args[0] === "r2" && args[2] === "info") return;
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
      readConfig: async () => existingConfig,
      writeConfig: async (_path, contents) => {
        writtenConfig = contents;
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(commands).toEqual([
      ["wrangler", "d1", "list", "--json"],
      ["wrangler", "d1", "migrations", "apply", "minutesbot", "--remote"],
      ["wrangler", "r2", "bucket", "info", "minutesbot-artifacts"],
      ["wrangler", "queues", "info", "minutesbot-invites"],
      ["wrangler", "queues", "info", "minutesbot-summaries"],
      ["wrangler", "queues", "create", "minutesbot-summaries"],
      ["wrangler", "queues", "info", "minutesbot-dlq"],
      ["wrangler", "queues", "create", "minutesbot-dlq"]
    ]);
    expect(JSON.parse(writtenConfig).d1_databases[0].database_id).toBe("real-db-id");
    expect(JSON.parse(writtenConfig).env.production.d1_databases[0].database_id).toBe("real-db-id");
  });

  it("creates missing D1 and R2 resources before queue checks", async () => {
    const commands: string[][] = [];
    let d1Exists = false;
    let r2Exists = false;

    await ensureCloudflareResources({
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "d1" && args[1] === "list") {
          return JSON.stringify(d1Exists ? [{ name: "minutesbot", uuid: "created-db-id" }] : []);
        }
        if (args[0] === "d1" && args[1] === "create") {
          d1Exists = true;
          return;
        }
        if (args[0] === "d1" && args[1] === "migrations") return;
        if (args[0] === "r2" && args[2] === "info") {
          if (r2Exists) return;
          throw new Error("not found");
        }
        if (args[0] === "r2" && args[2] === "create") {
          r2Exists = true;
          return;
        }
        if (args[0] === "queues" && args[1] === "info") return;
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
      readConfig: async () => existingConfig,
      writeConfig: async () => undefined,
      log: () => undefined,
      error: () => undefined
    });

    expect(commands).toEqual([
      ["wrangler", "d1", "list", "--json"],
      ["wrangler", "d1", "create", "minutesbot"],
      ["wrangler", "d1", "list", "--json"],
      ["wrangler", "d1", "migrations", "apply", "minutesbot", "--remote"],
      ["wrangler", "r2", "bucket", "info", "minutesbot-artifacts"],
      ["wrangler", "r2", "bucket", "create", "minutesbot-artifacts"],
      ["wrangler", "queues", "info", "minutesbot-invites"],
      ["wrangler", "queues", "info", "minutesbot-summaries"],
      ["wrangler", "queues", "info", "minutesbot-dlq"]
    ]);
  });

  it("fails fast when creating a missing queue fails", async () => {
    const commands: string[][] = [];
    const errors: string[] = [];

    await expect(
      ensureCloudflareResources({
        runCommand: async (command, args) => {
          commands.push([command, ...args]);
          if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "real-db-id" }]);
          if (args[0] === "d1" && args[1] === "migrations") return;
          if (args[0] === "r2" && args[2] === "info") return;
          if (args[1] === "info") throw new Error("not found");
          throw new Error("authentication failed");
        },
        readConfig: async () => existingConfig,
        writeConfig: async () => undefined,
        log: () => undefined,
        error: (message) => errors.push(message)
      })
    ).rejects.toThrow("authentication failed");

    expect(commands).toEqual([
      ["wrangler", "d1", "list", "--json"],
      ["wrangler", "d1", "migrations", "apply", "minutesbot", "--remote"],
      ["wrangler", "r2", "bucket", "info", "minutesbot-artifacts"],
      ["wrangler", "queues", "info", "minutesbot-invites"],
      ["wrangler", "queues", "create", "minutesbot-invites"]
    ]);
    expect(errors).toContain("Failed to create Cloudflare Queue minutesbot-invites: authentication failed");
  });

  it("uses staging queue names for the staging environment", async () => {
    const commands: string[][] = [];

    await ensureCloudflareResources({
      environment: "staging",
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot-staging", uuid: "real-staging-db-id" }]);
        if (args[0] === "d1" && args[1] === "migrations") return;
        if (args[0] === "r2" && args[2] === "info") return;
        if (args[1] === "info") throw new Error("not found");
      },
      readConfig: async () => existingConfig,
      writeConfig: async () => undefined,
      log: () => undefined,
      error: () => undefined
    });

    expect(commands).toEqual([
      ["wrangler", "d1", "list", "--json"],
      ["wrangler", "d1", "migrations", "apply", "minutesbot-staging", "--remote", "--env", "staging"],
      ["wrangler", "r2", "bucket", "info", "minutesbot-staging-artifacts"],
      ["wrangler", "queues", "info", "minutesbot-staging-invites"],
      ["wrangler", "queues", "create", "minutesbot-staging-invites"],
      ["wrangler", "queues", "info", "minutesbot-staging-summaries"],
      ["wrangler", "queues", "create", "minutesbot-staging-summaries"],
      ["wrangler", "queues", "info", "minutesbot-staging-dlq"],
      ["wrangler", "queues", "create", "minutesbot-staging-dlq"]
    ]);
  });

  it("does not treat authentication failures during inspection as missing resources", async () => {
    const errors: string[] = [];

    await expect(
      ensureCloudflareResources({
        runCommand: async (command, args) => {
          if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "real-db-id" }]);
          if (args[0] === "d1" && args[1] === "migrations") return;
          if (args[0] === "r2" && args[2] === "info") return;
          if (args[1] === "info") throw new Error("Authentication error: API token not found");
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
        readConfig: async () => existingConfig,
        writeConfig: async () => undefined,
        log: () => undefined,
        error: (message) => errors.push(message)
      })
    ).rejects.toThrow("Authentication error");

    expect(errors.some((message) => message.includes("Failed to inspect Cloudflare Queue minutesbot-invites"))).toBe(true);
  });

  it("updates the D1 database id in configs that contain comments", async () => {
    const commentedConfig = [
      "{",
      "  // managed by ensure-cloudflare-resources",
      '  "d1_databases": [',
      '    { "binding": "DB", "database_name": "minutesbot", "database_id": "stale-db-id" } /* stale */',
      "  ]",
      "}"
    ].join("\n");
    let writtenConfig = "";

    await ensureCloudflareResources({
      runCommand: async (_command, args) => {
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "real-db-id" }]);
        return;
      },
      readConfig: async () => commentedConfig,
      writeConfig: async (_path, contents) => {
        writtenConfig = contents;
      },
      log: () => undefined,
      error: () => undefined
    });

    expect(JSON.parse(writtenConfig).d1_databases[0].database_id).toBe("real-db-id");
  });
});

describe("stripJsonComments", () => {
  it("removes // and /* */ comments while preserving them inside strings", () => {
    const jsonc = [
      "{",
      "  // line comment",
      '  "url": "https://example.com/path", /* block comment */',
      '  "pattern": "a/*b*/c" // trailing comment',
      "}"
    ].join("\n");

    expect(JSON.parse(stripJsonComments(jsonc))).toEqual({ url: "https://example.com/path", pattern: "a/*b*/c" });
  });

  it("preserves escaped quotes inside strings", () => {
    expect(JSON.parse(stripJsonComments('{ "value": "say \\"hi\\" // not a comment" }'))).toEqual({ value: 'say "hi" // not a comment' });
  });
});
