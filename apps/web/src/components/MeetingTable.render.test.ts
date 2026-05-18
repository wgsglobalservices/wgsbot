import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingTable } from "./MeetingTable";

describe("MeetingTable uploaded transcript tests", () => {
  it("keeps row action layout inside a table cell", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingTable, {
        meetings: [
          {
            id: "mtg_1",
            subject: "Weekly Sales Meeting",
            organizer_email: "owner@wgs.bot",
            start_time: "2026-05-04T15:00:00.000Z",
            status: "SUMMARY_SENT",
            eligible_recipient_count: 2
          }
        ],
        onDelete: async () => undefined
      })
    );

    expect(html).toContain('class="rowActionsCell"');
    expect(html).toContain('class="rowActions"');
    expect(html).toContain('href="#/meeting/mtg_1"');
  });

  it("marks uploaded transcript recap test meetings", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingTable, {
        meetings: [
          {
            id: "mtg_test",
            calendar_uid: "test-recap-upload:abc",
            subject: "Uploaded Transcript Test",
            organizer_email: "owner@wgs.bot",
            start_time: "2026-05-04T15:00:00.000Z",
            status: "SUMMARY_SENT"
          }
        ]
      })
    );

    expect(html).toContain("Uploaded transcript test");
  });
});
