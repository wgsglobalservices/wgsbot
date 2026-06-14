import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusBadge, statusTone } from "./StatusBadge";

describe("statusTone", () => {
  it("maps every occurrence status to a tone", () => {
    expect(statusTone("scheduled")).toBe("neutral");
    expect(statusTone("join_queued")).toBe("active");
    expect(statusTone("in_meeting")).toBe("active");
    expect(statusTone("post_meeting")).toBe("active");
    expect(statusTone("transcribing")).toBe("active");
    expect(statusTone("summarizing")).toBe("active");
    expect(statusTone("sending_recap")).toBe("active");
    expect(statusTone("completed")).toBe("good");
    expect(statusTone("completed_no_eligible_recipients")).toBe("warning");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("canceled")).toBe("neutral");
    expect(statusTone("skipped")).toBe("neutral");
  });

  it("maps bot session states", () => {
    expect(statusTone("created")).toBe("neutral");
    expect(statusTone("warming")).toBe("active");
    expect(statusTone("browser_starting")).toBe("active");
    expect(statusTone("prejoin")).toBe("active");
    expect(statusTone("waiting_for_start")).toBe("active");
    expect(statusTone("waiting_room")).toBe("warning");
    expect(statusTone("joined")).toBe("active");
    expect(statusTone("recording")).toBe("active");
    expect(statusTone("stopping")).toBe("active");
    expect(statusTone("uploading")).toBe("active");
    expect(statusTone("post_processing_completed")).toBe("good");
  });

  it("maps transcript, recap, delivery, and job statuses", () => {
    expect(statusTone("pending")).toBe("neutral");
    expect(statusTone("running")).toBe("active");
    expect(statusTone("leased")).toBe("active");
    expect(statusTone("failed_retryable")).toBe("warning");
    expect(statusTone("failed_terminal")).toBe("bad");
    expect(statusTone("dead_letter")).toBe("bad");
    expect(statusTone("sent")).toBe("good");
    expect(statusTone("skipped_policy")).toBe("neutral");
  });

  it("maps inbound message and audit severities", () => {
    expect(statusTone("parsed")).toBe("good");
    expect(statusTone("rejected")).toBe("bad");
    expect(statusTone("ignored")).toBe("neutral");
    expect(statusTone("info")).toBe("neutral");
    expect(statusTone("warning")).toBe("warning");
    expect(statusTone("error")).toBe("bad");
  });

  it("falls back to keyword heuristics for unknown values", () => {
    expect(statusTone("chromium failed to start")).toBe("bad");
    expect(statusTone("everything ok")).toBe("good");
    expect(statusTone("something else")).toBe("neutral");
    expect(statusTone(null)).toBe("neutral");
  });
});

describe("StatusBadge", () => {
  it("renders the tone class and text", () => {
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "in_meeting" }))).toContain("badge active");
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "failed" }))).toContain("badge bad");
    expect(renderToStaticMarkup(React.createElement(StatusBadge, { value: "completed" }))).toContain("completed");
    expect(renderToStaticMarkup(React.createElement(StatusBadge, {}))).toContain("unknown");
  });
});
