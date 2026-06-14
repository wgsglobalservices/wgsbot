import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripJsonComments } from "./ensure-cloudflare-resources";

type WranglerConfig = {
  name?: string;
  account_id?: string;
  main?: string;
  routes?: Array<{ pattern?: string; custom_domain?: boolean }>;
  assets?: { binding?: string; directory?: string; run_worker_first?: boolean };
  vars?: Record<string, string>;
  d1_databases?: Array<{ binding?: string; database_name?: string; database_id?: string }>;
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  queues?: {
    producers?: Array<{ binding?: string; queue?: string }>;
    consumers?: Array<{ queue?: string; max_batch_size?: number; max_batch_timeout?: number; max_retries?: number; dead_letter_queue?: string }>;
  };
  triggers?: { crons?: string[] };
  send_email?: Array<{ name?: string; allowed_sender_addresses?: string[] }>;
  workflows?: unknown;
  services?: Array<{ binding?: string; service?: string }>;
  durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
  containers?: Array<{ class_name?: string; image?: string }>;
  migrations?: Array<{ tag?: string; deleted_classes?: string[]; new_sqlite_classes?: string[] }>;
};

function readConfig(path: string): { config: WranglerConfig; text: string } {
  const text = readFileSync(path, "utf8");
  return { config: JSON.parse(stripJsonComments(text)) as WranglerConfig, text };
}

describe("root wrangler config", () => {
  const { config, text } = readConfig("wrangler.jsonc");

  it("uses the production Worker that already owns the jobs queue consumer", () => {
    expect(config.name).toBe("wgsbot-notetaker");
  });

  it("binds D1, R2, the jobs queue producer, assets, and send_email", () => {
    expect(config.d1_databases).toEqual([
      expect.objectContaining({ binding: "DB", database_name: "minutesbot", database_id: expect.any(String) })
    ]);
    expect(config.r2_buckets).toEqual([expect.objectContaining({ binding: "ARTIFACTS", bucket_name: "minutesbot-artifacts" })]);
    expect(config.queues?.producers).toEqual([expect.objectContaining({ binding: "JOBS_QUEUE", queue: "minutesbot-jobs" })]);
    expect(config.assets).toEqual(expect.objectContaining({ binding: "ASSETS", run_worker_first: true }));
    expect(config.send_email).toEqual([expect.objectContaining({ name: "SEND_EMAIL", allowed_sender_addresses: expect.any(Array) })]);
  });

  it("consumes the jobs queue with a dead-letter queue", () => {
    const consumers = config.queues?.consumers ?? [];
    expect(consumers).toEqual([expect.objectContaining({ queue: "minutesbot-jobs", dead_letter_queue: "minutesbot-dlq" })]);
    for (const consumer of consumers) {
      expect(consumer.max_retries).toBe(5);
    }
  });

  it("schedules the per-minute sweep and the daily maintenance crons", () => {
    // The workflow cron handler dispatches on these exact expressions.
    expect(config.triggers?.crons).toEqual(["* * * * *", "0 3 * * *"]);
  });

  it("allows placeholders but never real account ids in source", () => {
    expect(config.account_id).toBeUndefined();
    // A real database id is fine locally (ensure-cloudflare-resources patches
    // it), but committed configs may also carry the placeholder.
    const databaseId = config.d1_databases?.[0]?.database_id ?? "";
    expect(databaseId.length).toBeGreaterThan(0);
    // No 32-hex Cloudflare account ids anywhere in the file.
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
  });

  it("binds the separate bot runtime worker as a service", () => {
    expect(config.services).toEqual([expect.objectContaining({ binding: "BOT_RUNTIME", service: "minutesbot-meeting-bot" })]);
    // The runtime is still deployed separately; the main worker only receives
    // a service binding to call it without traversing the public custom domain.
    expect(config.workflows).toBeUndefined();
    expect(config.durable_objects).toBeUndefined();
    expect(config.containers).toBeUndefined();
    // The legacy DO-deletion migration block was removed: it has long been
    // applied remotely and breaks fresh local dev environments.
    expect(config.migrations).toBeUndefined();
  });

  it("allows admin token auth in production when explicitly enabled", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.vars?.ALLOW_ADMIN_TOKEN_AUTH).toBe("true");
  });
});

describe("bot container wrangler config", () => {
  const { config, text } = readConfig("deploy/bot-container/wrangler.jsonc");

  it("matches the names deploy-bot-container.ts expects", () => {
    expect(config.name).toBe("minutesbot-meeting-bot");
    expect(config.main).toBe("src/index.ts");
    expect(config.containers).toEqual([expect.objectContaining({ class_name: "MeetingBotContainer", image: "../../Dockerfile.bot" })]);
    expect(config.durable_objects?.bindings).toEqual([expect.objectContaining({ name: "MEETING_BOT", class_name: "MeetingBotContainer" })]);
    expect(config.r2_buckets).toEqual([expect.objectContaining({ binding: "ARTIFACTS", bucket_name: "minutesbot-artifacts" })]);
    expect(config.vars?.BOT_RECORDING_BUCKET_NAME).toBe("minutesbot-artifacts");
  });

  it("never carries real account ids in source", () => {
    expect(config.account_id).toBeUndefined();
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});
