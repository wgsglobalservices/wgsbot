import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSampleRecapRecipient, defaultSettings, type AppSettings } from "@minutesbot/shared";
import { SettingsForm, configuredLabel, getTimeZoneOptions, parseAllowedDomains, parseEmailList, resolveSampleRecapRecipient } from "../components/SettingsForm";
import { fileToBotImageUpload, saveSetupSettings } from "./Setup";

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

describe("notetaker alias parsing", () => {
  it("accepts comma-separated and newline-separated emails", () => {
    expect(parseEmailList("sales-notes@wgs.bot, plant-notes@wgs.bot\nquality-notes@wgs.bot\n\n")).toEqual([
      "sales-notes@wgs.bot",
      "plant-notes@wgs.bot",
      "quality-notes@wgs.bot"
    ]);
  });
});

describe("time zone options", () => {
  it("keeps the configured time zone selectable", () => {
    expect(getTimeZoneOptions("America/Detroit")).toContain("America/Detroit");
  });
});

describe("setup status labels", () => {
  it("labels configured and missing secrets without exposing values", () => {
    expect(configuredLabel(true)).toBe("Configured");
    expect(configuredLabel(false)).toBe("Missing");
  });
});

describe("settings form", () => {
  it("renders transcript download expiration as a configurable setup field", () => {
    const html = renderToStaticMarkup(React.createElement(SettingsForm, { value: defaultSettings, onChange: () => undefined }));

    expect(html).toContain("Transcript link expiration");
    expect(html).toContain("hours");
    expect(html).toContain('value="24"');
  });
});

describe("sample recap recipient", () => {
  it("defaults missing saved settings to the WGS IT recipient", () => {
    expect(resolveSampleRecapRecipient(undefined)).toBe(defaultSampleRecapRecipient);
  });

  it("keeps an explicitly configured sample recipient", () => {
    expect(resolveSampleRecapRecipient("reviewer@example.com")).toBe("reviewer@example.com");
  });
});

describe("bot image upload", () => {
  it("compresses uploaded bot background images into optimized JPEG API input", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "wgsbot.png", { type: "image/png" });

    await expect(
      fileToBotImageUpload(file, async (uploaded) => {
        expect(uploaded).toBe(file);
        return new File([new Uint8Array([4, 5, 6])], "wgsbot-optimized.jpg", { type: "image/jpeg" });
      })
    ).resolves.toEqual({
      contentType: "image/jpeg",
      data: "BAUG",
      fileName: "wgsbot-optimized.jpg"
    });
  });
});
