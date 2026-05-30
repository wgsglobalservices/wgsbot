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

  it("does not render latest error details in the table", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingTable, {
        meetings: [
          {
            id: "mtg_error",
            subject: "Failure review",
            organizer_email: "owner@wgs.bot",
            start_time: "2026-05-04T15:00:00.000Z",
            status: "BOT_FATAL_ERROR",
            latest_error: "Attendee request failed"
          }
        ]
      })
    );

    expect(html).not.toContain("Latest error");
    expect(html).not.toContain("Attendee request failed");
  });

  it("separates upcoming meetings from past meetings", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingTable, {
        now: new Date("2026-05-30T12:00:00.000Z"),
        meetings: [
          {
            id: "mtg_past",
            subject: "Past Sales Meeting",
            organizer_email: "owner@wgs.bot",
            start_time: "2026-05-19T15:00:00.000Z",
            status: "SUMMARY_SENT"
          },
          {
            id: "mtg_future",
            subject: "Upcoming Sales Meeting",
            organizer_email: "owner@wgs.bot",
            start_time: "2026-06-01T15:00:00.000Z",
            status: "WAITING_TO_CREATE_BOT"
          }
        ]
      })
    );

    expect(html).toContain("Upcoming meetings");
    expect(html).toContain("Past meetings");
    expect(html.indexOf("Upcoming meetings")).toBeLessThan(html.indexOf("Upcoming Sales Meeting"));
    expect(html.indexOf("Upcoming Sales Meeting")).toBeLessThan(html.indexOf("Past meetings"));
    expect(html.indexOf("Past meetings")).toBeLessThan(html.indexOf("Past Sales Meeting"));
  });
});
