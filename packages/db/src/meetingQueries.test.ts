import { describe, expect, it } from "vitest";
import { deleteMeetingHistory, listMeetings } from "./meetingQueries";

class QueryD1 {
  sql = "";

  prepare(sql: string) {
    this.sql = sql;
    return {
      async all<T>() {
        return { results: [] as T[] };
      }
    };
  }
}

describe("meeting queries", () => {
  it("lists all meetings without a hard result cap", async () => {
    const db = new QueryD1();

    await listMeetings(db as unknown as D1Database);

    expect(db.sql.toLowerCase()).not.toContain("limit");
  });

  it("deletes meeting history from dependent tables before deleting the meeting", async () => {
    const deletedTables: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async run() {
            const match = sql.match(/^DELETE FROM (\w+)/);
            if (match) deletedTables.push(match[1]);
            return { success: true };
          }
        };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      }
    };

    await deleteMeetingHistory(db as unknown as D1Database, "mtg_1");

    expect(deletedTables).toEqual([
      "attendees",
      "attendee_webhook_events",
      "transcript_segments",
      "artifacts",
      "email_deliveries",
      "summaries",
      "meetings"
    ]);
  });
});
