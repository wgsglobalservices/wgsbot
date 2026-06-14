import { describe, expect, it } from "vitest";
import { deployBotContainer } from "./deploy-bot-container";

const sourceConfig = JSON.stringify(
  {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: "minutesbot-meeting-bot",
    main: "src/index.ts",
    routes: [{ pattern: "meeting-api.minutes.bot", custom_domain: true }],
    vars: {
      BOT_CONTAINER_SLEEP_AFTER: "24h",
      BOT_CONTAINER_INSTANCE_ID: "dev",
      BOT_RUNTIME_VERSION: "dev",
      BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
      BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
      BOT_WEBHOOK_BASE_URL: "https://meeting.minutes.bot"
    },
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: "minutesbot-artifacts" }],
    containers: [{ class_name: "MeetingBotContainer", image: "../../Dockerfile.bot", max_instances: 6, instance_type: "standard-2" }]
  },
  null,
  2
);

type CommandLog = { line: string; input?: string };

function createHarness(options: { secrets?: { bot: boolean; main: boolean } } = {}) {
  const commands: CommandLog[] = [];
  const writes = new Map<string, string>();
  const secrets = options.secrets ?? { bot: false, main: false };

  const runCommand = async (command: string, args: string[], commandOptions?: { input?: string }) => {
    commands.push({ line: `${command} ${args.join(" ")}`, input: commandOptions?.input });
    if (command === "git") return "fresh-sha";
    if (command === "wrangler" && args[0] === "secret" && args[1] === "list") {
      const onBotWorker = args.includes("--config");
      const has = onBotWorker ? secrets.bot : secrets.main;
      return JSON.stringify(has ? [{ name: "BOT_INTERNAL_TOKEN", type: "secret_text" }] : []);
    }
    return "";
  };

  return {
    commands,
    writes,
    deploy: (overrides: Parameters<typeof deployBotContainer>[0] = {}) =>
      deployBotContainer({
        runCommand,
        readTextFile: async () => sourceConfig,
        writeTextFile: async (path, contents) => {
          writes.set(path, contents);
        },
        makeDir: async () => undefined,
        generateToken: () => "generated-token",
        log: () => undefined,
        ...overrides
      })
  };
}

describe("deployBotContainer", () => {
  it("generates a fresh config with rewritten paths before deploying", async () => {
    const harness = createHarness({ secrets: { bot: true, main: true } });
    await harness.deploy();

    const generated = harness.writes.get(".wrangler/bot-container.jsonc") ?? "";
    const config = JSON.parse(generated);
    expect(config.main).toBe("../deploy/bot-container/src/index.ts");
    expect(config.containers[0].image).toBe("../Dockerfile.bot");
    expect(config.vars.BOT_RUNTIME_VERSION).toBe("fresh-sha");
    expect(config.vars.BOT_CONTAINER_INSTANCE_ID).toMatch(/^production-\d{14}-[0-9a-f]{8}$/);
    expect(generated).not.toContain('"BOT_RUNTIME_VERSION": "dev"');
    expect(harness.commands.map((c) => c.line)).toContain("wrangler deploy --config .wrangler/bot-container.jsonc");
    expect(harness.commands.map((c) => c.line)).toContain("docker info");
  });

  it("leaves BOT_INTERNAL_TOKEN alone when both workers already have it", async () => {
    const harness = createHarness({ secrets: { bot: true, main: true } });
    await harness.deploy();

    const puts = harness.commands.filter((c) => c.line.startsWith("wrangler secret put"));
    expect(puts).toEqual([]);
  });

  it("provisions the same fresh BOT_INTERNAL_TOKEN on both workers when missing", async () => {
    const harness = createHarness({ secrets: { bot: true, main: false } });
    await harness.deploy();

    const puts = harness.commands.filter((c) => c.line.startsWith("wrangler secret put"));
    expect(puts.map((c) => c.line)).toEqual([
      "wrangler secret put BOT_INTERNAL_TOKEN --config .wrangler/bot-container.jsonc",
      "wrangler secret put BOT_INTERNAL_TOKEN"
    ]);
    // Same value, supplied via stdin (never via argv where it would leak into process lists).
    expect(puts[0].input).toBe("generated-token");
    expect(puts[1].input).toBe("generated-token");
  });

  it("rotates the token on --rotate-token even when both workers have one", async () => {
    const harness = createHarness({ secrets: { bot: true, main: true } });
    await harness.deploy({ rotateToken: true });

    const puts = harness.commands.filter((c) => c.line.startsWith("wrangler secret put"));
    expect(puts).toHaveLength(2);
  });

  it("refuses to deploy a config that still contains placeholders", async () => {
    const harness = createHarness();
    await expect(
      harness.deploy({
        readTextFile: async () => sourceConfig.replaceAll("minutes.bot", "example.com")
      })
    ).rejects.toThrow("placeholder values");
    expect(harness.commands).toEqual([]);
  });

  it("fails with a clear message when docker is unavailable", async () => {
    const harness = createHarness();
    await expect(
      harness.deploy({
        runCommand: async (command, _args) => {
          if (command === "docker") throw new Error("Cannot connect to the Docker daemon");
          if (command === "git") return "fresh-sha";
          return "";
        }
      })
    ).rejects.toThrow("Docker is required");
  });

  it("preflights Wrangler auth before starting the container deploy", async () => {
    const harness = createHarness();
    const commands: string[] = [];

    await expect(
      harness.deploy({
        runCommand: async (command, args) => {
          commands.push(`${command} ${args.join(" ")}`);
          if (command === "git") return "fresh-sha";
          if (command === "docker") return "";
          if (command === "wrangler" && args[0] === "whoami") throw new Error("Not logged in.");
          return "";
        }
      })
    ).rejects.toThrow("Wrangler must be logged in");

    expect(commands).toContain("wrangler whoami");
    expect(commands).not.toContain("wrangler deploy --config .wrangler/bot-container.jsonc");
  });
});
