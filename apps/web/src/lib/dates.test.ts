import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatDurationSeconds, formatTimeRange, isPastIso } from "./dates";

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

describe("formatTimeRange", () => {
  it("collapses the end to time-only on the same day", () => {
    const text = formatTimeRange("2026-05-10T07:30:00.000Z", "2026-05-10T08:00:00.000Z");
    expect(text).toContain("2026");
    expect(text).toContain("–");
    expect(text.indexOf("2026")).toBe(text.lastIndexOf("2026"));
  });

  it("shows the full end date when it differs", () => {
    const text = formatTimeRange("2026-05-10T07:30:00.000Z", "2026-05-12T08:00:00.000Z");
    expect(text.indexOf("2026")).not.toBe(text.lastIndexOf("2026"));
  });

  it("degrades gracefully on missing or invalid input", () => {
    expect(formatTimeRange(null, null)).toBe("Not set");
    expect(formatTimeRange("not-a-date", "2026-05-10T08:00:00.000Z")).toBe("Invalid date");
    expect(formatTimeRange("2026-05-10T07:30:00.000Z", "nope")).toBe(formatDate("2026-05-10T07:30:00.000Z"));
  });
});

describe("formatDurationSeconds", () => {
  it("formats hours, minutes, and seconds", () => {
    expect(formatDurationSeconds(3725)).toBe("1h 02m");
    expect(formatDurationSeconds(125)).toBe("2m 05s");
    expect(formatDurationSeconds(45)).toBe("45s");
  });

  it("shows a placeholder for missing values", () => {
    expect(formatDurationSeconds(null)).toBe("—");
    expect(formatDurationSeconds(undefined)).toBe("—");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("shows a placeholder for missing values", () => {
    expect(formatBytes(null)).toBe("—");
  });
});

describe("isPastIso", () => {
  const now = Date.parse("2026-06-12T12:00:00.000Z");

  it("detects past and future timestamps against a reference time", () => {
    expect(isPastIso("2026-06-12T11:59:59.000Z", now)).toBe(true);
    expect(isPastIso("2026-06-12T12:00:01.000Z", now)).toBe(false);
  });

  it("treats missing or invalid timestamps as not past", () => {
    expect(isPastIso(null, now)).toBe(false);
    expect(isPastIso("not-a-date", now)).toBe(false);
  });
});
