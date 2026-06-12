import { describe, expect, it } from "vitest";
import { upsertMeeting } from "./meetingQueries";
import type { MeetingRow } from "./schema";

const insertColumns = [
  "id",
  "calendar_uid",
  "subject",
  "organizer_email",
  "organizer_name",
  "teams_join_url",
  "start_time",
  "end_time",
  "status",
  "attendee_bot_id",
  "attendee_bot_state",
  "attendee_transcription_state",
  "attendee_recording_state",
  "attendee_last_event_at",
  "transcript_status",
  "summary_status",
  "latest_error",
  "meeting_type",
  "source_recipient",
  "time_zone",
  "series_uid",
  "occurrence_index",
  "recurring",
  "created_at",
  "updated_at"
] as const;

// Emulates the ON CONFLICT upsert: the row read back reflects the last write.
function fakeDb(existing: MeetingRow | null): { db: D1Database; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  let current = existing;
  const db = {
    prepare(sql: string) {
      return {
        values: [] as unknown[],
        bind(...values: unknown[]) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM meetings WHERE calendar_uid")) return current;
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO meetings")) {
            inserts.push(this.values);
            const written = Object.fromEntries(insertColumns.map((column, index) => [column, this.values[index]])) as unknown as MeetingRow;
            current = current ? { ...written, id: current.id, created_at: current.created_at } : written;
          }
          return { success: true };
        }
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    }
  } as unknown as D1Database;
  return { db, inserts };
}

const existingMeeting: MeetingRow = {
  id: "mtg_live",
  calendar_uid: "uid-1",
  subject: "Original subject",
  organizer_email: "alice@company.com",
  organizer_name: "Alice",
  teams_join_url: "https://teams.microsoft.com/l/meetup-join/original",
  start_time: "2026-05-04T15:00:00.000Z",
  end_time: "2026-05-04T15:30:00.000Z",
  status: "BOT_RECORDING",
  attendee_bot_id: "bot_live",
  attendee_bot_state: "recording",
  transcript_status: "not_started",
  summary_status: "not_started",
  latest_error: null,
  created_at: "2026-05-04T14:00:00.000Z",
  updated_at: "2026-05-04T15:05:00.000Z"
};

describe("upsertMeeting", () => {
  it("preserves the live bot status when a calendar update arrives", async () => {
    const { db } = fakeDb(existingMeeting);

    const row = await upsertMeeting(db, {
      calendar_uid: "uid-1",
      subject: "Updated subject",
      organizer_email: "alice@company.com",
      teams_join_url: "https://teams.microsoft.com/l/meetup-join/updated",
      start_time: "2026-05-04T16:00:00.000Z",
      end_time: "2026-05-04T16:30:00.000Z",
      status: "SCHEDULED"
    });

    // The status must not be clobbered back to SCHEDULED while the bot is live.
    expect(row.status).toBe("BOT_RECORDING");
    expect(row.id).toBe("mtg_live");
    expect(row.subject).toBe("Updated subject");
  });

  it("preserves stored fields when a cancellation omits them", async () => {
    const { db } = fakeDb(existingMeeting);

    const row = await upsertMeeting(db, {
      calendar_uid: "uid-1",
      status: "CANCELLED"
    });

    expect(row.status).toBe("CANCELLED");
    expect(row.subject).toBe("Original subject");
    expect(row.teams_join_url).toBe("https://teams.microsoft.com/l/meetup-join/original");
    expect(row.organizer_name).toBe("Alice");
    expect(row.attendee_bot_id).toBe("bot_live");
  });

  it("allows re-scheduling after the bot has settled", async () => {
    const { db } = fakeDb({ ...existingMeeting, attendee_bot_state: "ended", status: "BOT_ENDED" });

    const row = await upsertMeeting(db, {
      calendar_uid: "uid-1",
      subject: "Rescheduled",
      status: "SCHEDULED"
    });

    expect(row.status).toBe("SCHEDULED");
  });
});
