import { describe, expect, it } from "vitest";
import { defaultSettings, type AppSettings } from "@minutesbot/shared";
import { getTimeZoneOptions, parseAllowedDomains } from "../components/SettingsForm";
import { saveSetupSettings } from "./Setup";

describe("setup save status", () => {
  it("returns saved settings with a visible saved message", async () => {
    await expect(saveSetupSettings(defaultSettings, async (settings) => settings)).resolves.toEqual({
      settings: defaultSettings,
      message: "Saved"
    });
  });

  it("returns an error message when saving fails", async () => {
    const result = await saveSetupSettings(defaultSettings, async (_settings: AppSettings) => {
      throw new Error("D1 write failed");
    });

    expect(result).toEqual({
      settings: defaultSettings,
      message: "D1 write failed"
    });
  });
});

describe("allowed domains parsing", () => {
  it("accepts comma-separated and newline-separated domains", () => {
    expect(parseAllowedDomains("wgsglobalservices.com, wgs.global\nsubsidiary.example\n\n partner.example")).toEqual([
      "wgsglobalservices.com",
      "wgs.global",
      "subsidiary.example",
      "partner.example"
    ]);
  });
});

describe("time zone options", () => {
  it("keeps the configured time zone selectable", () => {
    expect(getTimeZoneOptions("America/Detroit")).toContain("America/Detroit");
  });
});
