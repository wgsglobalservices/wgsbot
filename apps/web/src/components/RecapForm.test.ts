import { describe, expect, it } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { moveSection, updateSection } from "./RecapForm";

describe("recap form helpers", () => {
  it("updates section labels without mutating the original array", () => {
    const sections = defaultSettings.recap.sections;
    const next = updateSection(sections, "summary", { label: "Overview", enabled: false });

    expect(next.find((section) => section.key === "summary")).toMatchObject({ label: "Overview", enabled: false });
    expect(sections.find((section) => section.key === "summary")).toMatchObject({ label: "Summary", enabled: true });
  });

  it("moves sections by one slot and ignores out-of-range moves", () => {
    const moved = moveSection(defaultSettings.recap.sections, 1, -1);

    expect(moved.map((section) => section.key).slice(0, 2)).toEqual(["decisions", "summary"]);
    expect(moveSection(defaultSettings.recap.sections, 0, -1)).toBe(defaultSettings.recap.sections);
  });
});
