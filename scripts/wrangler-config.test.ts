import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type WranglerConfig = {
  queues?: {
    producers?: Array<{ binding?: string; queue?: string }>;
    consumers?: Array<{ queue?: string; max_batch_size?: number; max_batch_timeout?: number }>;
  };
  services?: Array<{ binding?: string; service?: string }>;
  durable_objects?: unknown;
  containers?: unknown;
  migrations?: Array<{ tag?: string; deleted_classes?: string[] }>;
};

function readRootWranglerConfig(): WranglerConfig {
  return JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as WranglerConfig;
}

describe("root wrangler config", () => {
  it("consumes queued invite and summary work in the deployed minutesbot Worker", () => {
    const config = readRootWranglerConfig();

    expect(config.queues?.consumers ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ queue: "minutesbot-invites" }),
        expect.objectContaining({ queue: "minutesbot-summaries" })
      ])
    );
  });

  it("does not bind the meeting bot runtime to the connected minutesbot Worker", () => {
    const config = readRootWranglerConfig();

    expect(config.services ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: "BOT_RUNTIME"
        })
      ])
    );
  });

  it("deletes the stale meeting bot Durable Object class from the connected minutesbot Worker", () => {
    const config = readRootWranglerConfig();

    expect(config.migrations ?? []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "remove-meeting-bot-container-from-minutesbot",
          deleted_classes: ["MeetingBotContainer"]
        })
      ])
    );
  });

  it("keeps container ownership out of the connected minutesbot Worker", () => {
    const config = readRootWranglerConfig();

    expect(config.durable_objects).toBeUndefined();
    expect(config.containers).toBeUndefined();
  });
});
