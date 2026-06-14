import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CalendarEventRow } from "../lib/types";
import { EventTable, eventDetailHref, groupOccurrencesByEvent, summarizeEventOccurrences } from "./EventTable";
import { makeOccurrence } from "./OccurrenceTable.test";

function makeEvent(overrides: Partial<CalendarEventRow> = {}): CalendarEventRow {
  return {
    id: "evt_1",
    ics_uid: "uid-1@teams",
    sequence: 2,
    organizer_email: "organizer@example.com",
    organizer_name: "Org Anizer",
    subject: "Weekly Sync",
    teams_join_url: "https://teams.microsoft.com/l/meetup-join/abc",
    start_time: "2026-05-10T07:30:00.000Z",
    end_time: "2026-05-10T08:00:00.000Z",
    time_zone: "America/Detroit",
    start_wall_clock: null,
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    rdates: null,
    exdates: null,
    is_recurring: 1,
    status: "active",
    expanded_until: null,
    last_inbound_message_id: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

describe("event table", () => {
  it("renders subject, organizer, recurring badge with the RRULE, and occurrence summary", () => {
    const html = renderToStaticMarkup(
      React.createElement(EventTable, {
        events: [makeEvent()],
        summaries: { evt_1: { nextStart: "2026-06-15T07:30:00.000Z", lastStart: "2026-06-08T07:30:00.000Z" } }
      })
    );

    expect(html).toContain('role="link"');
    expect(html).toContain('href="#/events/evt_1"');
    expect(html).toContain("Weekly Sync");
    expect(html).toContain("organizer@example.com");
    expect(html).toContain("recurring");
    expect(html).toContain('title="FREQ=WEEKLY;BYDAY=MO"');
    expect(html).toContain("badge good");
  });

  it("renders single-event badge for non-recurring events", () => {
    const html = renderToStaticMarkup(React.createElement(EventTable, { events: [makeEvent({ is_recurring: 0, rrule: null })] }));
    expect(html).toContain("single");
  });

  it("encodes event ids in detail hashes", () => {
    expect(eventDetailHref("evt/a b")).toBe("#/events/evt%2Fa%20b");
  });
});

describe("event occurrence summaries", () => {
  const now = Date.parse("2026-06-12T12:00:00.000Z");

  it("picks the soonest upcoming and most recent past start", () => {
    const occurrences = [
      makeOccurrence({ id: "a", start_time: "2026-06-01T07:30:00.000Z" }),
      makeOccurrence({ id: "b", start_time: "2026-06-08T07:30:00.000Z" }),
      makeOccurrence({ id: "c", start_time: "2026-06-15T07:30:00.000Z" }),
      makeOccurrence({ id: "d", start_time: "2026-06-22T07:30:00.000Z" })
    ];
    expect(summarizeEventOccurrences(occurrences, now)).toEqual({
      nextStart: "2026-06-15T07:30:00.000Z",
      lastStart: "2026-06-08T07:30:00.000Z"
    });
  });

  it("returns nulls when there are no occurrences on a side", () => {
    expect(summarizeEventOccurrences([], now)).toEqual({ nextStart: null, lastStart: null });
  });

  it("groups occurrences by event id", () => {
    const grouped = groupOccurrencesByEvent([
      makeOccurrence({ id: "a", event_id: "evt_1" }),
      makeOccurrence({ id: "b", event_id: "evt_2" }),
      makeOccurrence({ id: "c", event_id: "evt_1" })
    ]);
    expect(grouped.get("evt_1")?.map((row) => row.id)).toEqual(["a", "c"]);
    expect(grouped.get("evt_2")?.map((row) => row.id)).toEqual(["b"]);
  });
});
