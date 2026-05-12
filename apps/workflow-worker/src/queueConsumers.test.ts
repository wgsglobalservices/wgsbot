import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
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
      ATTENDEE_API_BASE_URL: "https://attendee.company.com",
      API_BASE_URL: "https://api.company.com"
    });
    expect(deleteObject).toHaveBeenCalled();
    expect(db.prepares.some((sql) => sql.includes("DELETE FROM audit_logs"))).toBe(true);
  });
});

describe("queue consumers", () => {
  it("handles explicit Attendee data deletion messages before acknowledging", async () => {
    const ack = vi.fn();
    const deleteCalls: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          return {
            bind() {
              return this;
            },
            async first() {
              if (sql.includes("FROM meetings")) {
                return { id: "mtg_1", attendee_bot_id: "bot_1" };
              }
              if (sql.includes("FROM settings")) {
                return {
                  key: "app",
                  value: JSON.stringify({
                    ...defaultSettings,
                    attendee: { ...defaultSettings.attendee, baseUrl: "https://app.attendee.dev" }
                  }),
                  updated_at: new Date().toISOString()
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
      } as unknown as D1Database,
      ARTIFACTS: {} as R2Bucket,
      INVITE_QUEUE: { send: vi.fn() },
      SUMMARY_QUEUE: { send: vi.fn() },
      EMAIL_QUEUE: { send: vi.fn() },
      ATTENDEE_API_KEY: "attendee-secret",
      ATTENDEE_API_BASE_URL: "https://app.attendee.dev",
      API_BASE_URL: "https://api.company.com",
      ATTENDEE_FETCHER: async (input: RequestInfo | URL, init?: RequestInit) => {
        deleteCalls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
    };

    await handleQueueBatch({ messages: [{ body: { type: "delete_attendee_data", meetingId: "mtg_1" }, ack }] } as unknown as MessageBatch<unknown>, env);

    expect(deleteCalls).toEqual(["POST https://app.attendee.dev/api/v1/bots/bot_1/delete_data"]);
    expect(ack).toHaveBeenCalledOnce();
  });
});
