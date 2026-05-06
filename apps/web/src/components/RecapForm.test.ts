import { describe, expect, it } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RecapForm,
  copyPromptText,
  getPromptPreview,
  getTemplateById,
  moveSection,
  recapTemplates,
  updateSection
} from "./RecapForm";

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

  it("defines the five suggested recap templates", () => {
    expect(recapTemplates.map((template) => template.title)).toEqual([
      "Auto-classified WGS recap",
      "Weekly SPQRC",
      "Weekly Sales",
      "Individual Plant Meeting",
      "General"
    ]);
    expect(getTemplateById("weekly_sales").structure).toContain("Sales forecast/pipeline");
    expect(getPromptPreview("auto", defaultSettings.recap.prompt)).toContain("classifier");
  });

  it("renders the recap template management surface", () => {
    const html = renderToStaticMarkup(React.createElement(RecapForm, { value: defaultSettings.recap, onChange: () => undefined }));

    expect(html).toContain("Templates");
    expect(html).toContain("Auto-classified WGS recap");
    expect(html).toContain("Weekly SPQRC");
    expect(html).toContain("Weekly Sales");
    expect(html).toContain("Individual Plant Meeting");
    expect(html).toContain("General");
    expect(html).toContain("Automation");
    expect(html).toContain("Automatic classification enabled");
    expect(html).toContain("Prompt preview");
    expect(html).toContain("Copy prompt");
    expect(html).toContain("Save recap");
  });

  it("copies prompt text when clipboard is available", async () => {
    const writes: string[] = [];
    const clipboard = {
      async writeText(value: string) {
        writes.push(value);
      }
    };

    await expect(copyPromptText("prompt text", clipboard)).resolves.toBe("Prompt copied");
    expect(writes).toEqual(["prompt text"]);
  });
});
