import { describe, expect, it } from "vitest";
import { formatAuditLogTime } from "./AuditLogTable";

describe("audit log time formatting", () => {
  it("formats raw audit timestamps with seconds and timezone", () => {
    expect(formatAuditLogTime("2026-05-06T05:31:16.070Z", "UTC")).toBe("May 6, 2026, 5:31:16 AM UTC");
  });

  it("keeps invalid timestamps visible", () => {
    expect(formatAuditLogTime("not-a-date", "UTC")).toBe("not-a-date");
  });
});
