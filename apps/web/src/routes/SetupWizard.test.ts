import { describe, expect, it } from "vitest";
import { wizardSteps } from "./SetupWizard";
import { saveSettingsDraft } from "./Settings";
import { defaultSettings } from "@minutesbot/shared";
import type { SettingsView } from "../lib/api";

describe("setup wizard steps", () => {
  it("walks company, domains, bot, providers, and email in order", () => {
    expect(wizardSteps.map((step) => step.key)).toEqual(["company", "domains", "bot", "providers", "email"]);
  });
});

describe("saveSettingsDraft", () => {
  const view: SettingsView = {
    settings: defaultSettings,
    secrets: {
      aiKeyConfigured: false,
      transcriptionKeyConfigured: false,
      botInternalTokenConfigured: false,
      sessionSecretConfigured: true
    }
  };

  it("returns the saved view with a saved message", async () => {
    await expect(saveSettingsDraft(defaultSettings, async () => view)).resolves.toEqual({ view, message: "Saved" });
  });

  it("returns the error message when saving fails", async () => {
    const result = await saveSettingsDraft(defaultSettings, async () => {
      throw new Error("D1 write failed");
    });
    expect(result).toEqual({ view: null, message: "D1 write failed" });
  });
});
