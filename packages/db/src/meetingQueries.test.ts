import { describe, expect, it } from "vitest";
import { deleteMeetingRecord, listMeetings, markStaleRecurringOccurrencesCancelled } from "./meetingQueries";

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

class DeleteQueryD1 {
  calls: Array<{ sql: string; values: unknown[] }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async run() {
        db.calls.push({ sql, values: this.values });
        return { success: true };
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

  it("deletes a meeting and its dependent history rows", async () => {
    const db = new DeleteQueryD1();

    await deleteMeetingRecord(db as unknown as D1Database, "mtg_1");

    expect(db.calls.map((call) => call.sql)).toEqual([
      "DELETE FROM attendees WHERE meeting_id = ?",
      "DELETE FROM transcript_segments WHERE meeting_id = ?",
      "DELETE FROM attendee_webhook_events WHERE meeting_id = ?",
      "DELETE FROM summaries WHERE meeting_id = ?",
      "DELETE FROM email_deliveries WHERE meeting_id = ?",
      "DELETE FROM artifacts WHERE meeting_id = ?",
      "DELETE FROM meetings WHERE id = ?"
    ]);
    expect(db.calls.every((call) => call.values[0] === "mtg_1")).toBe(true);
  });

  it("marks stale future generated recurrence rows cancelled when a series changes", async () => {
    const db = new DeleteQueryD1();

    await markStaleRecurringOccurrencesCancelled(db as unknown as D1Database, {
      seriesUid: "series-1",
      keepCalendarUids: ["series-1:20260601T160000Z", "series-1:20260608T160000Z"],
      nowIso: "2026-05-30T12:00:00.000Z"
    });

    expect(db.calls[0].sql).toContain("calendar_uid LIKE ?");
    expect(db.calls[0].sql).toContain("calendar_uid NOT IN (?, ?)");
    expect(db.calls[0].values).toEqual([
      "CANCELLED",
      null,
      "2026-05-30T12:00:00.000Z",
      "series-1:%",
      "series-1:20260601T160000Z",
      "series-1:20260608T160000Z",
      "2026-05-30T12:00:00.000Z"
    ]);
  });
});
