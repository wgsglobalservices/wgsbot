import { describe, expect, it } from "vitest";
import { canCancelBot, canRetryJoin } from "./OccurrenceDetail";

const now = Date.parse("2026-06-12T12:00:00.000Z");

describe("canRetryJoin", () => {
  it("allows retry while the meeting window is open and no bot is active", () => {
    expect(canRetryJoin({ status: "failed", end_time: "2026-06-12T13:00:00.000Z" }, now)).toBe(true);
    expect(canRetryJoin({ status: "scheduled", end_time: "2026-06-12T13:00:00.000Z" }, now)).toBe(true);
  });

  it("disables retry once the meeting window has passed", () => {
    expect(canRetryJoin({ status: "failed", end_time: "2026-06-12T11:00:00.000Z" }, now)).toBe(false);
    expect(canRetryJoin({ status: "failed", end_time: "2026-06-12T12:00:00.000Z" }, now)).toBe(false);
  });

  it("disables retry while a bot session is already queued or in the meeting", () => {
    expect(canRetryJoin({ status: "join_queued", end_time: "2026-06-12T13:00:00.000Z" }, now)).toBe(false);
    expect(canRetryJoin({ status: "in_meeting", end_time: "2026-06-12T13:00:00.000Z" }, now)).toBe(false);
  });
});

describe("canCancelBot", () => {
  it("allows cancellation only while a bot is queued or in the meeting", () => {
    expect(canCancelBot({ status: "join_queued" })).toBe(true);
    expect(canCancelBot({ status: "in_meeting" })).toBe(true);
    expect(canCancelBot({ status: "scheduled" })).toBe(false);
    expect(canCancelBot({ status: "completed" })).toBe(false);
  });
});
