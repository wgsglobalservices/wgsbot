import { describe, expect, it, vi } from "vitest";
import { cleanupOldArtifacts } from "./queueConsumers";

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
      API_BASE_URL: "https://api.minutes.bot"
    });
    expect(deleteObject).toHaveBeenCalled();
    expect(db.prepares.some((sql) => sql.includes("DELETE FROM audit_logs"))).toBe(true);
  });
});
