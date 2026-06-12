import { describe, expect, it, vi } from "vitest";
import { app } from "../index";

class HardeningD1 {
  meetingUpdates: unknown[][] = [];
  webhookEvents: unknown[][] = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings WHERE id")) {
          return {
            id: "mtg_1",
            attendee_bot_id: "bot_current",
            status: "BOT_RECORDING",
            transcript_status: "not_started",
            summary_status: "not_started"
          };
        }
        return null;
      },
      async run() {
        if (sql.includes("INTO attendee_webhook_events")) db.webhookEvents.push(this.values);
        if (sql.includes("UPDATE meetings")) db.meetingUpdates.push(this.values);
        return { success: true, meta: { changes: 1 } };
      },
      async all() {
        return { results: [] };
      }
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function env(db: HardeningD1) {
  return {
    DB: db as unknown as D1Database,
    ARTIFACTS: {} as R2Bucket,
    INVITE_QUEUE: { send: vi.fn() },
    SUMMARY_QUEUE: { send: vi.fn(async () => undefined) },
    BOT_INTERNAL_TOKEN: "managed-token",
    SESSION_SECRET: "test-secret"
  };
}

function post(payload: unknown, db: HardeningD1) {
  return app.request(
    "/api/webhooks/bot",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer managed-token" },
      body: JSON.stringify(payload)
    },
    env(db)
  );
}

describe("bot webhook hardening", () => {
  it("rejects webhooks without an idempotency key", async () => {
    const db = new HardeningD1();
    const response = await post(
      {
        bot_id: "bot_current",
        bot_metadata: { minutesbot_meeting_id: "mtg_1" },
        trigger: "bot.state_change",
        data: { event_type: "state_change", new_state: "joining" }
      },
      db
    );

    expect(response.status).toBe(400);
    expect(db.meetingUpdates).toEqual([]);
  });

  it("ignores webhooks whose bot id does not match the meeting's recorded bot", async () => {
    const db = new HardeningD1();
    const response = await post(
      {
        idempotency_key: "stale-bot-event",
        bot_id: "bot_stale",
        bot_metadata: { minutesbot_meeting_id: "mtg_1" },
        trigger: "bot.state_change",
        data: { event_type: "fatal_error", new_state: "failed" }
      },
      db
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ignored: true, meetingId: "mtg_1" });
    expect(db.meetingUpdates).toEqual([]);
    expect(db.webhookEvents).toEqual([]);
  });
});
