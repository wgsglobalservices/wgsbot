import { describe, expect, it, vi } from "vitest";
import { cleanupOldArtifacts, handleQueueBatch } from "./queueConsumers";

class FakeD1 {
  prepares: string[] = [];
  prepare(sql: string) {
    this.prepares.push(sql);
    return {
      bind() {
        return this;
      },
      async first() {
        return null;
      },
      async all() {
        return { results: [{ id: "art_1", r2_key: "raw/a.eml" }] };
      },
      async run() {
        return { success: true };
      }
    };
  }
}

class MonitorD1 {
  prepares: string[] = [];
  prepare(sql: string) {
    this.prepares.push(sql);
    return {
      bind() {
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings")) {
          return {
            id: "mtg_1",
            attendee_bot_id: "bot_new",
            attendee_bot_state: "joining",
            status: "BOT_JOINING"
          };
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        return { success: true };
      }
    };
  }
}

describe("retention cleanup", () => {
  it("deletes expired artifacts and writes audit logs", async () => {
    const db = new FakeD1();
    const deleteObject = vi.fn(async () => undefined);
    await cleanupOldArtifacts({
      DB: db as unknown as D1Database,
      ARTIFACTS: { delete: deleteObject } as unknown as R2Bucket,
      INVITE_QUEUE: { send: vi.fn() },
      SUMMARY_QUEUE: { send: vi.fn() },
      EMAIL_QUEUE: { send: vi.fn() },
      BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
      API_BASE_URL: "https://api.minutes.bot"
    });
    expect(deleteObject).toHaveBeenCalled();
    expect(db.prepares.some((sql) => sql.includes("DELETE FROM audit_logs"))).toBe(true);
  });
});

describe("queue consumers", () => {
  it("routes monitor_bot_join messages through the workflow queue handler", async () => {
    const db = new MonitorD1();
    const ack = vi.fn();

    await handleQueueBatch(
      {
        messages: [
          {
            body: { type: "monitor_bot_join", meetingId: "mtg_1", botId: "bot_old" },
            ack
          }
        ]
      } as unknown as MessageBatch<unknown>,
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
        API_BASE_URL: "https://api.minutes.bot"
      }
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(db.prepares.some((sql) => sql.includes("FROM meetings WHERE id"))).toBe(true);
  });

  it("routes cancel_bot messages through the workflow queue handler", async () => {
    const db = new MonitorD1();
    const ack = vi.fn();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        requests.push(String(url));
        return Response.json({ id: "bot_new", meeting_url: "https://teams.microsoft.com/l/meetup-join/abc", state: "cancelling" });
      })
    );

    await handleQueueBatch(
      {
        messages: [
          {
            body: { type: "cancel_bot", meetingId: "mtg_1", botId: "bot_new", reason: "calendar_cancel" },
            ack
          }
        ]
      } as unknown as MessageBatch<unknown>,
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: {} as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: { send: vi.fn() },
        EMAIL_QUEUE: { send: vi.fn() },
        BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
        API_BASE_URL: "https://api.minutes.bot"
      }
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(requests).toEqual(["https://meeting-api.minutes.bot/api/v1/bots/bot_new/cancel"]);
  });
});
