import { describe, expect, it } from "vitest";
import { formatDate } from "./dates";

describe("formatDate", () => {
  it("formats valid ISO timestamps", () => {
    expect(formatDate("2026-05-10T07:34:28.951Z")).toContain("2026");
  });

  it("returns a placeholder when no timestamp is provided", () => {
    expect(formatDate()).toBe("Not set");
    expect(formatDate(null)).toBe("Not set");
    expect(formatDate("")).toBe("Not set");
  });

  it("returns Invalid date for malformed timestamps instead of throwing", () => {
    expect(formatDate("not-a-date")).toBe("Invalid date");
  });
});
