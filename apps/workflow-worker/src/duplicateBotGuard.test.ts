import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { createMeetingBot, monitorBotJoin } from "./botCreation";
import type { WorkflowEnv } from "./env";

const createBot = vi.fn();
const checkHealth = vi.fn(async () => ({ ok: true }));
const getBot = vi.fn();

vi.mock("@minutesbot/bot-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@minutesbot/bot-client")>();
  return {
    ...original,
    BotClient: vi.fn(() => ({ createBot, checkHealth, getBot }))
  };
});

function fakeDb(meeting: Record<string, unknown>): { db: D1Database; auditEvents: unknown[][]; updates: unknown[][] } {
  const auditEvents: unknown[][] = [];
  const updates: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM settings")) {
            return { key: "app", value: JSON.stringify(defaultSettings), updated_at: new Date().toISOString() };
          }
          if (sql.includes("FROM meetings")) return meeting;
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO audit_logs")) auditEvents.push(this.values);
          if (sql.includes("UPDATE meetings")) updates.push(this.values);
          return { success: true };
        },
        async all() {
          return { results: [] };
        }
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  return { db, auditEvents, updates };
}

function env(db: D1Database): WorkflowEnv {
  return {
    DB: db,
    ARTIFACTS: { get: vi.fn(async () => null) } as unknown as R2Bucket,
    INVITE_QUEUE: { send: vi.fn(async () => undefined) },
    SUMMARY_QUEUE: { send: vi.fn(async () => undefined) },
    BOT_API_BASE_URL: "https://meeting-api.example.com",
    BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
    API_BASE_URL: "https://api.example.com"
  };
}

describe("duplicate bot guard", () => {
  it("does not create a second bot while one is live", async () => {
    createBot.mockClear();
    const { db, auditEvents } = fakeDb({
      id: "mtg_1",
      status: "BOT_RECORDING",
      attendee_bot_id: "bot_live",
      attendee_bot_state: "recording",
      teams_join_url: "https://teams.microsoft.com/l/meetup-join/abc",
      start_time: "2026-05-04T15:00:00.000Z"
    });

    await createMeetingBot(env(db), "mtg_1");

    expect(createBot).not.toHaveBeenCalled();
    expect(auditEvents.some((values) => JSON.stringify(values).includes("bot already active"))).toBe(true);
  });

  it("creates a replacement bot once the previous bot has settled", async () => {
    createBot.mockClear();
    createBot.mockResolvedValueOnce({ id: "bot_new", state: "queued" });
    const { db } = fakeDb({
      id: "mtg_1",
      status: "SCHEDULED",
      attendee_bot_id: "bot_old",
      attendee_bot_state: "failed",
      teams_join_url: "https://teams.microsoft.com/l/meetup-join/abc",
      start_time: "2026-05-04T15:00:00.000Z"
    });

    await createMeetingBot(env(db), "mtg_1");

    expect(createBot).toHaveBeenCalledTimes(1);
  });
});

describe("monitor resilience", () => {
  it("re-queues monitoring instead of declaring fatal when the runtime is unreachable", async () => {
    getBot.mockClear();
    getBot.mockRejectedValue(new Error("network down"));
    const { db, updates } = fakeDb({
      id: "mtg_1",
      status: "BOT_JOINING",
      attendee_bot_id: "bot_live",
      attendee_bot_state: "joining"
    });
    const testEnv = env(db);

    await monitorBotJoin(testEnv, "mtg_1", "bot_live", 1);

    expect(testEnv.INVITE_QUEUE.send).toHaveBeenCalledWith(
      { type: "monitor_bot_join", meetingId: "mtg_1", botId: "bot_live", attempt: 2 },
      { delaySeconds: 60 }
    );
    expect(updates).toEqual([]);
  });

  it("declares failure with an unreachable-runtime message after exhausting attempts", async () => {
    getBot.mockClear();
    getBot.mockRejectedValue(new Error("network down"));
    const { db, updates } = fakeDb({
      id: "mtg_1",
      status: "BOT_JOINING",
      attendee_bot_id: "bot_live",
      attendee_bot_state: "joining"
    });

    await monitorBotJoin(env(db), "mtg_1", "bot_live", 5);

    expect(updates.length).toBeGreaterThan(0);
    expect(JSON.stringify(updates)).toContain("unreachable");
  });
});
