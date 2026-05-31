import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildMeetingsPath, Meetings } from "./Meetings";

describe("Meetings route", () => {
  it("requests meetings with the selected future window", () => {
    expect(buildMeetingsPath(7)).toBe("/api/meetings?futureDays=7");
    expect(buildMeetingsPath(30)).toBe("/api/meetings?futureDays=30");
  });

  it("renders a default 7 day future window selector", () => {
    const html = renderToStaticMarkup(React.createElement(Meetings));

    expect(html).toContain("Show future");
    expect(html).toMatch(/<option[^>]*value="7"[^>]*selected=""/);
    expect(html).toContain("7 days");
  });
});
