import { describe, expect, it } from "vitest";
import { parseHash } from "./App";

describe("app routing", () => {
  it("routes the empty hash to the dashboard", () => {
    expect(parseHash("")).toEqual({ name: "dashboard" });
    expect(parseHash("#/")).toEqual({ name: "dashboard" });
  });

  it("routes list pages by name", () => {
    expect(parseHash("#/meetings")).toEqual({ name: "meetings" });
    expect(parseHash("#/jobs")).toEqual({ name: "jobs" });
    expect(parseHash("#/bot")).toEqual({ name: "bot" });
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
    expect(parseHash("#/setup")).toEqual({ name: "setup" });
    expect(parseHash("#/logs")).toEqual({ name: "logs" });
  });

  it("routes detail pages with decoded ids", () => {
    expect(parseHash("#/events/evt_1")).toEqual({ name: "event", id: "evt_1" });
    expect(parseHash("#/occurrences/occ%2Fa%20b")).toEqual({ name: "occurrence", id: "occ/a b" });
  });

  it("maps legacy hashes onto the new pages", () => {
    expect(parseHash("#/meeting/mtg_1")).toEqual({ name: "meetings" });
    expect(parseHash("#/recap")).toEqual({ name: "settings" });
    expect(parseHash("#/attendee")).toEqual({ name: "bot" });
  });

  it("falls back to the dashboard for unknown hashes", () => {
    expect(parseHash("#/unknown")).toEqual({ name: "dashboard" });
  });
});
