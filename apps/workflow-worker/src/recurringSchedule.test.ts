import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { extendRecurringMeetingSchedules } from "./recurringSchedule";
import type { WorkflowEnv } from "./env";

class RecurringScheduleD1 {
  existingCalendarUids = new Set(["series-weekly:20260601T150000Z"]);
  meetings: unknown[][] = [];
  attendees: unknown[][] = [];
  artifacts: unknown[][] = [];
  seriesUpdates: unknown[][] = [];
  settings = defaultSettings;
  series = [
    {
      series_uid: "series-weekly",
      subject: "Weekly sync",
      organizer_email: "alice@wgs.bot",
      organizer_name: "Alice",
      teams_join_url: "https://teams.microsoft.com/l/meetup-join/19%3aseries%40thread.v2/0?context=%7b%7d",
      first_start_time: "2026-06-01T15:00:00.000Z",
      first_end_time: "2026-06-01T15:30:00.000Z",
      time_zone: null,
      recurrence_json: JSON.stringify({ frequency: "weekly", interval: 1, byDay: ["MO"] }),
      attendees_json: JSON.stringify([
        {
          email: "alex@wgs.bot",
          name: "Alex",
          role: null,
          domain: "wgs.bot",
          summary_eligible: 1,
          exclusion_reason: null
        }
      ]),
      meeting_type: "general",
      source_recipient: "notetaker@wgs.bot",
      raw_invite_r2_key: "raw-invites/2026-05-30/series.eml",
      raw_invite_size_bytes: 1024,
      status: "ACTIVE",
      expanded_until: "2026-06-01T15:00:00.000Z",
      created_at: "2026-05-30T12:00:00.000Z",
      updated_at: "2026-05-30T12:00:00.000Z"
    }
  ];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM settings")) {
          return { key: "app", value: JSON.stringify(db.settings), updated_at: new Date().toISOString() } as T;
        }
        if (sql.includes("FROM meetings WHERE calendar_uid = ?")) return null;
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM meeting_series")) return { results: db.series as T[] };
        if (sql.includes("SELECT calendar_uid FROM meetings")) {
          return { results: Array.from(db.existingCalendarUids).map((calendar_uid) => ({ calendar_uid })) as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes("INSERT INTO meetings")) {
          db.meetings.push(this.values);
          db.existingCalendarUids.add(this.values[1] as string);
        }
        if (sql.includes("INSERT INTO attendees")) db.attendees.push(this.values);
        if (sql.includes("INSERT INTO artifacts")) db.artifacts.push(this.values);
        if (sql.startsWith("UPDATE meeting_series")) db.seriesUpdates.push(this.values);
        return { success: true, meta: { changes: 1 } };
      }
    };
  }
}

function env(db: RecurringScheduleD1, queueSend = vi.fn(async () => undefined)): WorkflowEnv {
  return {
    DB: db as unknown as D1Database,
    ARTIFACTS: {} as R2Bucket,
    INVITE_QUEUE: { send: queueSend },
    SUMMARY_QUEUE: { send: vi.fn() },
    EMAIL_QUEUE: { send: vi.fn() },
    ATTENDEE_API_BASE_URL: "https://attendee.example.com",
    ATTENDEE_API_KEY: "attendee-secret",
    ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME: "minutesbot-artifacts",
    API_BASE_URL: "https://minutesbot.example.com"
  };
}

describe("recurring schedule extension", () => {
  it("creates missing future occurrences for active recurring series", async () => {
    const db = new RecurringScheduleD1();
    const queueSend = vi.fn(async () => undefined);

    const created = await extendRecurringMeetingSchedules(env(db, queueSend), {
      now: new Date("2026-06-01T12:00:00.000Z"),
      horizonDays: 22,
      maxOccurrences: 4
    });

    expect(created).toBe(3);
    expect(db.meetings.map((values) => [values[1], values[6], values[7], values[8]])).toEqual([
      ["series-weekly:20260608T150000Z", "2026-06-08T15:00:00.000Z", "2026-06-08T15:30:00.000Z", "WAITING_TO_CREATE_BOT"],
      ["series-weekly:20260615T150000Z", "2026-06-15T15:00:00.000Z", "2026-06-15T15:30:00.000Z", "WAITING_TO_CREATE_BOT"],
      ["series-weekly:20260622T150000Z", "2026-06-22T15:00:00.000Z", "2026-06-22T15:30:00.000Z", "WAITING_TO_CREATE_BOT"]
    ]);
    expect(db.meetings.every((values) => values.includes("series-weekly"))).toBe(true);
    expect(db.attendees).toHaveLength(3);
    expect(db.artifacts).toHaveLength(3);
    expect(db.seriesUpdates.at(-1)?.[2]).toBe("series-weekly");
    expect(queueSend).not.toHaveBeenCalled();
  });
});
