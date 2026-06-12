import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { handleQueueBatch, cleanupOldArtifacts } from "./queueConsumers";
import type { WorkflowEnv } from "./env";

const deleteBotData = vi.fn(async () => undefined);

vi.mock("@minutesbot/bot-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@minutesbot/bot-client")>();
  return {
    ...original,
    BotClient: vi.fn(() => ({ deleteBotData }))
  };
});

type FakeMessage = {
  body: unknown;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

function message(body: unknown): FakeMessage {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

function fakeDb(options: { meeting?: Record<string, unknown> | null } = {}): { db: D1Database; auditEvents: unknown[][] } {
  const auditEvents: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM settings")) return null;
          if (sql.includes("FROM meetings")) return options.meeting ?? null;
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO audit_logs")) auditEvents.push(this.values);
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
  return { db, auditEvents };
}

function env(db: D1Database): WorkflowEnv {
  return {
    DB: db,
    ARTIFACTS: { delete: vi.fn(async () => undefined) } as unknown as R2Bucket,
    INVITE_QUEUE: { send: vi.fn(async () => undefined) },
    SUMMARY_QUEUE: { send: vi.fn(async () => undefined) },
    BOT_API_BASE_URL: "https://meeting-api.example.com",
    API_BASE_URL: "https://api.example.com"
  };
}

describe("queue consumer reliability", () => {
  it("handles delete_attendee_data by deleting bot runtime data and auditing", async () => {
    deleteBotData.mockClear();
    const { db, auditEvents } = fakeDb({ meeting: { id: "mtg_1", attendee_bot_id: "bot_9" } });
    const msg = message({ type: "delete_attendee_data", meetingId: "mtg_1" });

    await handleQueueBatch({ messages: [msg] } as unknown as MessageBatch<unknown>, env(db));

    expect(deleteBotData).toHaveBeenCalledWith("bot_9");
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(auditEvents.some((values) => values.includes("attendee.delete_data_called"))).toBe(true);
  });

  it("acks malformed messages instead of poisoning the batch", async () => {
    const { db } = fakeDb();
    const malformed = message(null);
    const unknownType = message({ type: "mystery" });

    await handleQueueBatch({ messages: [malformed, unknownType] } as unknown as MessageBatch<unknown>, env(db));

    expect(malformed.ack).toHaveBeenCalled();
    expect(unknownType.ack).toHaveBeenCalled();
    expect(malformed.retry).not.toHaveBeenCalled();
  });

  it("retries transient failures and still processes the rest of the batch", async () => {
    deleteBotData.mockClear();
    deleteBotData.mockRejectedValueOnce(new Error("runtime unavailable"));
    const { db } = fakeDb({ meeting: { id: "mtg_1", attendee_bot_id: "bot_9" } });
    const failing = message({ type: "delete_attendee_data", meetingId: "mtg_1" });
    const healthy = message({ type: "delete_attendee_data", meetingId: "mtg_1" });

    await handleQueueBatch({ messages: [failing, healthy] } as unknown as MessageBatch<unknown>, env(db));

    expect(failing.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(failing.ack).not.toHaveBeenCalled();
    expect(healthy.ack).toHaveBeenCalled();
  });
});

describe("retention cleanup of summaries", () => {
  it("deletes expired summary rows and their R2 objects", async () => {
    const deletedKeys: string[] = [];
    const deletedSummaryIds: string[] = [];
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
            return null;
          },
          async all() {
            if (sql.includes("FROM summaries")) {
              return { results: [{ id: "sum_1", r2_key: "summaries/mtg_1/summary.json" }] };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("DELETE FROM summaries")) deletedSummaryIds.push(this.values[0] as string);
            return { success: true };
          }
        };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        return Promise.all(statements.map((statement) => statement.run()));
      }
    } as unknown as D1Database;

    await cleanupOldArtifacts({
      ...env(db),
      ARTIFACTS: { delete: vi.fn(async (key: string) => void deletedKeys.push(key)) } as unknown as R2Bucket
    });

    expect(deletedKeys).toContain("summaries/mtg_1/summary.json");
    expect(deletedSummaryIds).toEqual(["sum_1"]);
  });
});
