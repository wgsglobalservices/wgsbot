import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttendeeRow } from "../lib/types";
import { AttendeeTable, describeAttendeeEligibility } from "./AttendeeTable";

function makeAttendee(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    id: "att_1",
    event_id: "evt_1",
    occurrence_id: null,
    email: "user@company.com",
    name: "User One",
    role: "REQ-PARTICIPANT",
    domain: "company.com",
    is_external: 0,
    recipient_eligible: 1,
    exclusion_reason: null,
    created_at: "2026-05-01T00:00:00.000Z",
    ...overrides
  };
}

describe("describeAttendeeEligibility", () => {
  it("marks eligible recipients as good", () => {
    expect(describeAttendeeEligibility(makeAttendee())).toEqual({ label: "Eligible", tone: "good" });
  });

  it("surfaces the exclusion reason for ineligible internal attendees", () => {
    const display = describeAttendeeEligibility(
      makeAttendee({ recipient_eligible: 0, exclusion_reason: "recorder_alias" })
    );
    expect(display.label).toBe("Excluded: recorder_alias");
    expect(display.tone).toBe("neutral");
    expect(display.detail).toBe("recorder_alias");
  });

  it("flags excluded external attendees with a warning tone", () => {
    const display = describeAttendeeEligibility(
      makeAttendee({ recipient_eligible: 0, is_external: 1, exclusion_reason: "external_domain" })
    );
    expect(display.tone).toBe("warning");
    expect(display.label).toBe("Excluded: external_domain");
  });

  it("falls back to a generic label when no reason was recorded", () => {
    const display = describeAttendeeEligibility(makeAttendee({ recipient_eligible: 0 }));
    expect(display.label).toBe("Not eligible");
  });
});

describe("attendee table", () => {
  it("renders eligibility and external flags per attendee", () => {
    const html = renderToStaticMarkup(
      React.createElement(AttendeeTable, {
        attendees: [
          makeAttendee(),
          makeAttendee({ id: "att_2", email: "guest@other.com", domain: "other.com", is_external: 1, recipient_eligible: 0, exclusion_reason: "external_domain" })
        ]
      })
    );

    expect(html).toContain("user@company.com");
    expect(html).toContain("Eligible");
    expect(html).toContain("guest@other.com");
    expect(html).toContain("external");
    expect(html).toContain("Excluded: external_domain");
  });

  it("renders an empty state without a table", () => {
    const html = renderToStaticMarkup(React.createElement(AttendeeTable, { attendees: [] }));
    expect(html).toContain("No attendees recorded.");
    expect(html).not.toContain("<table");
  });
});
