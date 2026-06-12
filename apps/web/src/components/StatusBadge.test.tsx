import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("classifies lifecycle terminal and transition states readably", () => {
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "BOT_ENDED" }))).toContain("badge good");
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "CANCELLED" }))).toContain("badge neutral");
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "cancelling" }))).toContain("badge neutral");
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "BOT_POST_PROCESSING" }))).toContain("badge neutral");
  });
});
