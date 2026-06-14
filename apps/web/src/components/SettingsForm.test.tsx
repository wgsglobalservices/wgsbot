import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import {
  SettingsForm,
  getTimeZoneOptions,
  keyConfiguredLabel,
  parseAllowedDomains,
  parseEmailList,
  resolveListTextDraft,
  updateSettingsPath
} from "./SettingsForm";

describe("settings list parsing", () => {
  it("accepts comma-separated and newline-separated domains", () => {
    expect(parseAllowedDomains("company.com, acme.global\nsubsidiary.example\n\n partner.example")).toEqual([
      "company.com",
      "acme.global",
      "subsidiary.example",
      "partner.example"
    ]);
  });

  it("accepts comma-separated and newline-separated emails", () => {
    expect(parseEmailList("sales@minutes.bot, plant@minutes.bot\nquality@minutes.bot\n\n")).toEqual([
      "sales@minutes.bot",
      "plant@minutes.bot",
      "quality@minutes.bot"
    ]);
  });

  it("preserves typed delimiters while the parsed list has not changed", () => {
    expect(resolveListTextDraft("minutes.bot", "minutes.bot,", ["minutes.bot"])).toBe("minutes.bot,");
    expect(resolveListTextDraft("minutes.bot", "other.example", ["minutes.bot"])).toBe("minutes.bot");
  });
});

describe("updateSettingsPath", () => {
  it("immutably updates nested settings paths", () => {
    const updated = updateSettingsPath(defaultSettings, "bot.displayName", "Recorder Bot");
    expect(updated.bot.displayName).toBe("Recorder Bot");
    expect(defaultSettings.bot.displayName).not.toBe("Recorder Bot");
    expect(updated.companyName).toBe(defaultSettings.companyName);
  });
});

describe("settings helpers", () => {
  it("labels key presence", () => {
    expect(keyConfiguredLabel(true)).toBe("Configured");
    expect(keyConfiguredLabel(false)).toBe("Missing");
  });

  it("always offers UTC and the current zone", () => {
    const options = getTimeZoneOptions("America/Detroit");
    expect(options).toContain("UTC");
    expect(options).toContain("America/Detroit");
  });
});

describe("settings form rendering", () => {
  it("renders every section for the default settings shape", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsForm, {
        value: defaultSettings,
        secrets: {
          aiKeyConfigured: true,
          transcriptionKeyConfigured: false,
          botInternalTokenConfigured: true,
          sessionSecretConfigured: true
        },
        onChange: () => undefined
      })
    );

    expect(html).toContain("Organization");
    expect(html).toContain("Domains &amp; Policy");
    expect(html).toContain("Meeting Bot");
    expect(html).toContain("Transcription");
    expect(html).toContain("Recap Generation");
    expect(html).toContain("Email Delivery");
    expect(html).toContain("Scheduling");
    expect(html).toContain("Retention");
    expect(html).toContain("Secrets");
    // Fixed policy invariants render as locked rows, not editable toggles.
    expect(html).toContain("Always on");
    expect(html).toContain("Always off");
    expect(html).toContain("wrangler secret put TRANSCRIPTION_API_KEY");
  });
});
