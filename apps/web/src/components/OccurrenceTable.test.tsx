import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OccurrenceRow } from "../lib/types";
import { OccurrenceTable, occurrenceDetailHref } from "./OccurrenceTable";

export function makeOccurrence(overrides: Partial<OccurrenceRow> = {}): OccurrenceRow {
  return {
    id: "occ_1",
    event_id: "evt_1",
    occurrence_key: "20260510T073000Z",
    recurrence_id: null,
    sequence: 0,
    is_override: 0,
    subject: "Daily Standup",
    teams_join_url: null,
    start_time: "2026-05-10T07:30:00.000Z",
    end_time: "2026-05-10T08:00:00.000Z",
    status: "scheduled",
    scheduled_join_time: "2026-05-10T07:25:00.000Z",
    latest_bot_session_id: null,
    join_attempts: 0,
    last_error: null,
    canceled_at: null,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

describe("occurrence table", () => {
  it("renders rows as openable link targets with status badges", () => {
    const html = renderToStaticMarkup(
      React.createElement(OccurrenceTable, {
        occurrences: [makeOccurrence({ status: "in_meeting", last_error: "boom" })]
      })
    );

    expect(html).toContain('role="link"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('href="#/occurrences/occ_1"');
    expect(html).toContain("Daily Standup");
    expect(html).toContain("badge active");
    expect(html).toContain("boom");
  });

  it("marks override occurrences", () => {
    const html = renderToStaticMarkup(
      React.createElement(OccurrenceTable, { occurrences: [makeOccurrence({ is_override: 1 })] })
    );
    expect(html).toContain("override");
  });

  it("renders empty state text when there are no rows", () => {
    const html = renderToStaticMarkup(React.createElement(OccurrenceTable, { occurrences: [], emptyText: "Nothing here." }));
    expect(html).toContain("Nothing here.");
    expect(html).not.toContain("<table");
  });

  it("encodes occurrence ids in detail hashes", () => {
    expect(occurrenceDetailHref("occ/a b")).toBe("#/occurrences/occ%2Fa%20b");
  });
});
