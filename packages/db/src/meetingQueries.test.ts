import { describe, expect, it } from "vitest";
import { deleteMeetingRecord, listMeetings, markStaleRecurringOccurrencesCancelled, upsertMeeting } from "./meetingQueries";

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

class UpsertQueryD1 {
  calls: Array<{ sql: string; values: unknown[] }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        return null;
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

  it("persists meeting type and source recipient when upserting meetings", async () => {
    const db = new UpsertQueryD1();

    await upsertMeeting(db as unknown as D1Database, {
      calendar_uid: "weekly-sales-1",
      subject: "Weekly Sales",
      organizer_email: "alice@wgs.bot",
      organizer_name: "Alice",
      teams_join_url: "https://teams.example/join",
      start_time: "2026-05-04T15:00:00.000Z",
      end_time: "2026-05-04T15:30:00.000Z",
      status: "SCHEDULED",
      meeting_type: "weekly_sales",
      source_recipient: "sales-recap@wgs.services"
    });

    const insert = db.calls.find((call) => call.sql.includes("INSERT OR REPLACE INTO meetings"));
    expect(insert?.sql).toContain("meeting_type");
    expect(insert?.sql).toContain("source_recipient");
    expect(insert?.values[17]).toBe("weekly_sales");
    expect(insert?.values[18]).toBe("sales-recap@wgs.services");
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
