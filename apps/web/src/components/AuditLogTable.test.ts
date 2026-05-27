import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatAuditLogTime } from "./AuditLogTable";
import { AuditLogTable } from "./AuditLogTable";

describe("audit log time formatting", () => {
  it("formats raw audit timestamps with seconds and timezone", () => {
    expect(formatAuditLogTime("2026-05-06T05:31:16.070Z", "UTC")).toBe("May 6, 2026, 5:31:16 AM UTC");
  });

  it("keeps invalid timestamps visible", () => {
    expect(formatAuditLogTime("not-a-date", "UTC")).toBe("not-a-date");
  });
});

describe("AuditLogTable layout controls", () => {
  const logs = [
    {
      id: "newer",
      created_at: "2026-05-07T05:31:16.070Z",
      event_type: "email.sent",
      actor_email: "newer@example.com",
      resource_type: "meeting",
      resource_id: "mtg_newer",
      metadata: "{\"recipient\":\"newer@example.com\"}"
    },
    {
      id: "older",
      created_at: "2026-05-06T05:31:16.070Z",
      event_type: "invite.ignored",
      actor_email: "older@example.com",
      resource_type: "invite",
      resource_id: "ign_older",
      metadata: "{\"status\":\"IGNORED_NON_CALENDAR_EMAIL\"}"
    }
  ];

  it("renders audit columns in the configured order", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditLogTable, {
        logs,
        timeZone: "UTC",
        columnOrder: ["metadata", "event", "time", "actor", "resource"]
      })
    );

    expect(html.indexOf("<th>Metadata</th>")).toBeLessThan(html.indexOf("<th>Event</th>"));
    expect(html.indexOf("<th>Event</th>")).toBeLessThan(html.indexOf("<th>Time</th>"));
  });

  it("can render older audit rows before newer rows", () => {
    const html = renderToStaticMarkup(
      React.createElement(AuditLogTable, {
        logs,
        timeZone: "UTC",
        rowOrder: "oldest"
      })
    );

    expect(html.indexOf("invite.ignored")).toBeLessThan(html.indexOf("email.sent"));
  });

  it("wraps the table in an audit log scroll region", () => {
    const html = renderToStaticMarkup(React.createElement(AuditLogTable, { logs, timeZone: "UTC" }));

    expect(html).toContain('class="auditLogTableWrap tableScroll"');
    expect(html).toContain('class="auditLogTable"');
  });
});
