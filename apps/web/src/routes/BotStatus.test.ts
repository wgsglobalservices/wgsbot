import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotStatus } from "./BotStatus";

describe("meeting bot status route", () => {
  it("does not render manual bot credential setup copy", () => {
    const html = renderToStaticMarkup(React.createElement(BotStatus));

    expect(html).not.toContain("API key");
    expect(html).not.toContain("Webhook secret");
    expect(html).not.toContain("Meeting bot setup copy block");
    expect(html).not.toContain("wrangler secret put");
  });
});
