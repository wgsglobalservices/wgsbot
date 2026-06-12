import { describe, expect, it } from "vitest";
import { File as NodeFile } from "node:buffer";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSampleRecapRecipient, defaultSettings, type AppSettings } from "@minutesbot/shared";
import { SettingsForm, configuredLabel, getTimeZoneOptions, parseAllowedDomains, parseEmailList, resolveListTextDraft, resolveSampleRecapRecipient, withSampleRecapRecipient } from "../components/SettingsForm";
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
    expect(parseAllowedDomains("company.com, acme.global\nsubsidiary.example\n\n partner.example")).toEqual([
      "company.com",
      "acme.global",
      "subsidiary.example",
      "partner.example"
    ]);
  });

  it("preserves typed delimiters while the parsed domain list has not changed", () => {
    expect(resolveListTextDraft("minutes.bot", "minutes.bot,", ["minutes.bot"])).toBe("minutes.bot,");
    expect(resolveListTextDraft("minutes.bot", "minutes.bot\n", ["minutes.bot"])).toBe("minutes.bot\n");
  });
});

describe("notetaker alias parsing", () => {
  it("accepts comma-separated and newline-separated emails", () => {
    expect(parseEmailList("sales-notes@minutes.bot, plant-notes@minutes.bot\nquality-notes@minutes.bot\n\n")).toEqual([
      "sales-notes@minutes.bot",
      "plant-notes@minutes.bot",
      "quality-notes@minutes.bot"
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

  it("renders the meeting bot runtime as built in without credential setup fields", () => {
    const html = renderToStaticMarkup(React.createElement(SettingsForm, { value: defaultSettings, onChange: () => undefined }));

    expect(html).toContain("Built in");
    expect(html).toContain("Managed");
    expect(html).toContain("Runtime URL");
    expect(html).not.toContain("Bot API key");
    expect(html).not.toContain("Webhook secret");
    expect(html).not.toContain("Not configured");
  });

  it("renders the outbound email sender display name as a configurable setup field", () => {
    const html = renderToStaticMarkup(React.createElement(SettingsForm, { value: defaultSettings, onChange: () => undefined }));

    expect(html).toContain("Sender display name");
    expect(html).toContain('value="minutesbot"');
  });

  it("constrains numeric setup fields to the server schema ranges", () => {
    const html = renderToStaticMarkup(React.createElement(SettingsForm, { value: defaultSettings, onChange: () => undefined }));

    expect(html).toContain('min="0"');
    expect(html).toContain('max="180"');
    expect(html).toContain('max="240"');
    expect(html).toContain('max="3650"');
    expect(html).toContain('max="720"');
  });

  it("renders the authenticated sender policy toggle", () => {
    const html = renderToStaticMarkup(React.createElement(SettingsForm, { value: defaultSettings, onChange: () => undefined }));

    expect(html).toContain("Require authenticated sender (SPF/DKIM/DMARC)");
  });

  it("renders the smtp endpoint field only for the smtp email provider", () => {
    const smtpSettings: AppSettings = { ...defaultSettings, email: { ...defaultSettings.email, provider: "smtp" } };
    const smtpHtml = renderToStaticMarkup(React.createElement(SettingsForm, { value: smtpSettings, onChange: () => undefined }));
    const mockHtml = renderToStaticMarkup(React.createElement(SettingsForm, { value: defaultSettings, onChange: () => undefined }));

    expect(smtpHtml).toContain("SMTP endpoint");
    expect(smtpHtml).toContain("https://smtp-bridge.example.com/send");
    expect(mockHtml).not.toContain("SMTP endpoint");
  });
});

describe("sample recap recipient", () => {
  it("defaults missing saved settings to the generic admin recipient", () => {
    expect(resolveSampleRecapRecipient(undefined)).toBe(defaultSampleRecapRecipient);
  });

  it("keeps an explicitly configured sample recipient", () => {
    expect(resolveSampleRecapRecipient("reviewer@example.com")).toBe("reviewer@example.com");
  });

  it("updates the saveable email test recipient setting", () => {
    const updated = withSampleRecapRecipient(defaultSettings, "reviewer@example.com");

    expect(updated.email.testRecipient).toBe("reviewer@example.com");
    expect(defaultSettings.email.testRecipient).toBe(defaultSampleRecapRecipient);
  });
});

describe("bot image upload", () => {
  it("compresses uploaded bot background images into optimized JPEG API input", async () => {
    const file = new NodeFile([new Uint8Array([1, 2, 3])], "minutesbot.png", { type: "image/png" }) as unknown as File;

    await expect(
      fileToBotImageUpload(file, async (uploaded) => {
        expect(uploaded).toBe(file);
        return new NodeFile([new Uint8Array([4, 5, 6])], "minutesbot-optimized.jpg", { type: "image/jpeg" }) as unknown as File;
      })
    ).resolves.toEqual({
      contentType: "image/jpeg",
      data: "BAUG",
      fileName: "minutesbot-optimized.jpg"
    });
  });
});
