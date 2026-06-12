import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeetingTable, meetingDetailHref } from "./MeetingTable";

describe("meeting table", () => {
  it("renders each meeting row as an openable link target with remove action", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingTable, {
        meetings: [
          {
            id: "mtg_1",
            start_time: "2026-05-10T07:30:00.000Z",
            subject: "Daily Standup",
            organizer_email: "organizer@example.com",
            status: "BOT_JOINING"
          }
        ],
        onRemoveMeeting: () => undefined
      })
    );

    expect(html).toContain('role="link"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('href="#/meeting/mtg_1"');
    expect(html).toContain("Remove");
    expect(html).toContain('aria-label="Remove Daily Standup from history"');
  });

  it("encodes meeting ids in detail hashes", () => {
    expect(meetingDetailHref("mtg/a b")).toBe("#/meeting/mtg%2Fa%20b");
  });
});
