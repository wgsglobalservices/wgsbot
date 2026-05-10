import { describe, expect, it, vi } from "vitest";
import { app } from "../index";

class WebhookD1 {
  webhookEvents: unknown[][] = [];
  meetingUpdates: unknown[][] = [];

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
            attendee_bot_id: "bot_1",
            status: "BOT_RECORDING",
            transcript_status: "not_started",
            summary_status: "not_started"
          };
        }
        if (sql.includes("FROM attendee_webhook_events")) return null;
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO attendee_webhook_events")) db.webhookEvents.push(this.values);
        if (sql.includes("UPDATE meetings")) db.meetingUpdates.push(this.values);
        return { success: true };
      }
    };
  }
}

describe("meeting bot webhook route", () => {
  it("accepts signed post-processing webhooks and queues R2 transcript processing", async () => {
    const db = new WebhookD1();
    const summaryQueue = { send: vi.fn(async () => undefined) };
    const payload = postProcessingPayload("wh_1");

    const response = await app.request(
      "/api/webhooks/bot",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer managed-token"
        },
        body: JSON.stringify(payload)
      },
      env(db, summaryQueue)
    );

    expect(response.status).toBe(200);
    expect(summaryQueue.send).toHaveBeenCalledWith({ type: "fetch_transcript", meetingId: "mtg_1", botId: "bot_1" });
    expect(db.webhookEvents).toHaveLength(1);
    expect(db.meetingUpdates).toHaveLength(1);
  });

  it("accepts the signed meeting bot webhook path with a trailing slash", async () => {
    const db = new WebhookD1();
    const summaryQueue = { send: vi.fn(async () => undefined) };
    const payload = postProcessingPayload("wh_2");

    const response = await app.request(
      "/api/webhooks/bot/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer managed-token"
        },
        body: JSON.stringify(payload)
      },
      env(db, summaryQueue)
    );

    expect(response.status).toBe(200);
    expect(summaryQueue.send).toHaveBeenCalledWith({ type: "fetch_transcript", meetingId: "mtg_1", botId: "bot_1" });
  });

  it("accepts signed chat message update webhooks", async () => {
    const db = new WebhookD1();
    const summaryQueue = { send: vi.fn(async () => undefined) };
    const payload = {
      idempotency_key: "wh_chat_1",
      bot_id: "bot_1",
      bot_metadata: { minutesbot_meeting_id: "mtg_1", calendar_uid: "teams-link-1" },
      trigger: "chat_messages.update",
      data: {
        message: "Can you share the deck?",
        sender_name: "Peter Gustafson"
      }
    };

    const response = await app.request(
      "/api/webhooks/bot",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer managed-token"
        },
        body: JSON.stringify(payload)
      },
      env(db, summaryQueue)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, duplicate: false, meetingId: "mtg_1" });
    expect(summaryQueue.send).not.toHaveBeenCalled();
    expect(db.webhookEvents).toHaveLength(1);
  });

  it("stores fatal meeting bot errors on the meeting", async () => {
    const db = new WebhookD1();
    const summaryQueue = { send: vi.fn(async () => undefined) };
    const payload = {
      idempotency_key: "wh_failed_1",
      bot_id: "bot_1",
      bot_metadata: { minutesbot_meeting_id: "mtg_1", calendar_uid: "teams-link-1" },
      trigger: "bot.state_change",
      data: {
        event_type: "fatal_error",
        new_state: "failed",
        transcription_state: "failed",
        recording_state: "failed",
        latest_error: "Teams pre-join screen did not show a Join now button"
      }
    };

    const response = await app.request(
      "/api/webhooks/bot",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer managed-token"
        },
        body: JSON.stringify(payload)
      },
      env(db, summaryQueue)
    );

    expect(response.status).toBe(200);
    expect(summaryQueue.send).not.toHaveBeenCalled();
    expect(db.meetingUpdates.at(-1)).toEqual([
      "bot_1",
      "failed",
      "failed",
      "failed",
      expect.any(String),
      "BOT_FATAL_ERROR",
      "Teams pre-join screen did not show a Join now button",
      expect.any(String),
      "mtg_1"
    ]);
  });

  it("returns Worker JSON for malformed managed webhook bodies", async () => {
    const db = new WebhookD1();
    const rawBody = "{bad-json";

    const response = await app.request(
      "/api/webhooks/bot",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer managed-token"
        },
        body: rawBody
      },
      env(db, { send: vi.fn(async () => undefined) })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_BOT_WEBHOOK_PAYLOAD" } });
  });

  it("rejects webhooks with the wrong managed authorization token", async () => {
    const db = new WebhookD1();
    const payload = postProcessingPayload("wh_bad_auth");

    const response = await app.request(
      "/api/webhooks/bot",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token"
        },
        body: JSON.stringify(payload)
      },
      env(db, { send: vi.fn(async () => undefined) })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_BOT_WEBHOOK_AUTH" } });
  });

  it("keeps protected admin APIs behind the admin token", async () => {
    const response = await app.request(
      "/api/settings",
      {
        method: "GET"
      },
      env(new WebhookD1(), { send: vi.fn(async () => undefined) })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

function postProcessingPayload(idempotencyKey: string) {
  return {
    idempotency_key: idempotencyKey,
    bot_id: "bot_1",
    bot_metadata: { minutesbot_meeting_id: "mtg_1", calendar_uid: "teams-link-1" },
    trigger: "bot.state_change",
    data: {
      event_type: "post_processing_completed",
      new_state: "ended",
      transcription_state: "complete",
      recording_state: "complete"
    }
  };
}

function env(db: WebhookD1, summaryQueue: { send: ReturnType<typeof vi.fn> }) {
  return {
    DB: db as unknown as D1Database,
    ARTIFACTS: {} as R2Bucket,
    INVITE_QUEUE: { send: vi.fn() },
    SUMMARY_QUEUE: summaryQueue,
    EMAIL_QUEUE: { send: vi.fn() },
    BOT_INTERNAL_TOKEN: "managed-token",
    SESSION_SECRET: "test-secret"
  };
}
