import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingTable } from "./MeetingTable";

describe("MeetingTable", () => {
  it("renders meeting rows as detail links with a delete action", () => {
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

    expect(html).toContain('class="clickableRow"');
    expect(html).toContain('role="link"');
    expect(html).toContain('href="#/meeting/mtg_1"');
    expect(html).toContain("Delete");
  });
});
