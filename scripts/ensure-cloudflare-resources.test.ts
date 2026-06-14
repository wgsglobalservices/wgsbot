import { describe, expect, it } from "vitest";
import { ensureCloudflareResources, patchD1DatabaseId, stripJsonComments } from "./ensure-cloudflare-resources";

const existingConfig = JSON.stringify(
  {
    vars: { DEFAULT_RECORDER_EMAIL: "notetaker@example.com" },
    d1_databases: [{ binding: "DB", database_name: "minutesbot", database_id: "<D1_DATABASE_ID>" }],
    send_email: [{ name: "SEND_EMAIL", allowed_sender_addresses: ["notetaker@example.com"] }]
  },
  null,
  2
);

describe("ensureCloudflareResources", () => {
  it("creates only missing queues after ensuring durable storage", async () => {
    const commands: string[][] = [];
    const existingQueues = new Set(["minutesbot-jobs"]);
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
      readConfig: async () => (writtenConfig === "" ? existingConfig : writtenConfig),
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
      ["wrangler", "queues", "info", "minutesbot-jobs"],
      ["wrangler", "queues", "info", "minutesbot-dlq"],
      ["wrangler", "queues", "create", "minutesbot-dlq"]
    ]);
    expect(JSON.parse(stripJsonComments(writtenConfig)).d1_databases[0].database_id).toBe("real-db-id");
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
      ["wrangler", "queues", "info", "minutesbot-jobs"],
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
      ["wrangler", "queues", "info", "minutesbot-jobs"],
      ["wrangler", "queues", "create", "minutesbot-jobs"]
    ]);
    expect(errors).toContain("Failed to create Cloudflare Queue minutesbot-jobs: authentication failed");
  });

  it("uses staging resource names for the staging environment", async () => {
    const commands: string[][] = [];
    const stagingConfig = JSON.stringify({
      d1_databases: [{ binding: "DB", database_name: "minutesbot-staging", database_id: "stale" }]
    });

    await ensureCloudflareResources({
      environment: "staging",
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot-staging", uuid: "real-staging-db-id" }]);
        if (args[0] === "d1" && args[1] === "migrations") return;
        if (args[0] === "r2" && args[2] === "info") return;
        if (args[1] === "info") throw new Error("not found");
      },
      readConfig: async () => stagingConfig,
      writeConfig: async () => undefined,
      log: () => undefined,
      error: () => undefined
    });

    expect(commands).toEqual([
      ["wrangler", "d1", "list", "--json"],
      ["wrangler", "d1", "migrations", "apply", "minutesbot-staging", "--remote", "--env", "staging"],
      ["wrangler", "r2", "bucket", "info", "minutesbot-staging-artifacts"],
      ["wrangler", "queues", "info", "minutesbot-staging-jobs"],
      ["wrangler", "queues", "create", "minutesbot-staging-jobs"],
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

    expect(errors.some((message) => message.includes("Failed to inspect Cloudflare Queue minutesbot-jobs"))).toBe(true);
  });

  it("prints a plan without running any commands in dry-run mode", async () => {
    const commands: string[][] = [];
    const messages: string[] = [];
    let wrote = false;

    await ensureCloudflareResources({
      dryRun: true,
      runCommand: async (command, args) => {
        commands.push([command, ...args]);
      },
      readConfig: async () => existingConfig,
      writeConfig: async () => {
        wrote = true;
      },
      log: (message) => messages.push(message),
      error: () => undefined
    });

    expect(commands).toEqual([]);
    expect(wrote).toBe(false);
    expect(messages.join("\n")).toContain("Dry run");
    expect(messages.join("\n")).toContain("D1 database minutesbot");
    expect(messages.join("\n")).toContain("queue minutesbot-jobs");
    expect(messages.join("\n")).toContain("queue minutesbot-dlq");
    expect(messages.join("\n")).toContain("Email Routing");
  });

  it("reports the manual Email Routing and send_email steps", async () => {
    const messages: string[] = [];

    await ensureCloudflareResources({
      runCommand: async (_command, args) => {
        if (args[0] === "d1" && args[1] === "list") return JSON.stringify([{ name: "minutesbot", uuid: "real-db-id" }]);
        return;
      },
      readConfig: async () => existingConfig,
      writeConfig: async () => undefined,
      log: (message) => messages.push(message),
      error: () => undefined
    });

    const output = messages.join("\n");
    expect(output).toContain("route notetaker@example.com to the minutesbot Worker");
    expect(output).toContain("notetaker@example.com must belong to a zone");
  });
});

describe("patchD1DatabaseId", () => {
  it("replaces the <D1_DATABASE_ID> placeholder while preserving comments", () => {
    const commented = [
      "{",
      "  // Self-hosting: replace every <PLACEHOLDER> below.",
      '  "d1_databases": [',
      "    {",
      '      "binding": "DB",',
      '      "database_name": "minutesbot",',
      '      "database_id": "<D1_DATABASE_ID>" /* patched by ensure */',
      "    }",
      "  ]",
      "}"
    ].join("\n");

    const patched = patchD1DatabaseId(commented, "minutesbot", "real-db-id");

    expect(patched).toContain('"database_id": "real-db-id"');
    expect(patched).toContain("// Self-hosting: replace every <PLACEHOLDER> below.");
    expect(patched).toContain("/* patched by ensure */");
    expect(JSON.parse(stripJsonComments(patched)).d1_databases[0].database_id).toBe("real-db-id");
  });

  it("replaces a stale real id and supports database_id listed first", () => {
    const reversed = '{ "d1_databases": [{ "database_id": "stale", "database_name": "minutesbot", "binding": "DB" }] }';
    expect(JSON.parse(patchD1DatabaseId(reversed, "minutesbot", "fresh")).d1_databases[0].database_id).toBe("fresh");
  });

  it("does not touch entries for other databases", () => {
    const twoDatabases = JSON.stringify({
      d1_databases: [
        { binding: "DB", database_name: "minutesbot", database_id: "old" },
        { binding: "OTHER", database_name: "other-db", database_id: "keep-me" }
      ]
    });
    const patched = JSON.parse(patchD1DatabaseId(twoDatabases, "minutesbot", "new"));
    expect(patched.d1_databases[0].database_id).toBe("new");
    expect(patched.d1_databases[1].database_id).toBe("keep-me");
  });

  it("throws when no entry matches the database name", () => {
    expect(() => patchD1DatabaseId('{ "d1_databases": [] }', "minutesbot", "id")).toThrow("Could not find a d1_databases entry");
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
