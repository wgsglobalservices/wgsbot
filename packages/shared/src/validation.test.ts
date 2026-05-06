import { describe, expect, it } from "vitest";
import { defaultSettings, parseSettings } from "./validation";

describe("settings validation", () => {
  it("normalizes domains and emails", () => {
    const settings = parseSettings({
      ...defaultSettings,
      primaryDomain: "AcMe.COM",
      allowedDomains: ["AcMe.COM", "acme.com"],
      recorderEmail: "NoteTaker@Meet.AcMe.COM",
      email: { ...defaultSettings.email, senderEmail: "Notes@AcMe.COM" }
    });

    expect(settings.primaryDomain).toBe("acme.com");
    expect(settings.allowedDomains).toEqual(["acme.com"]);
    expect(settings.recorderEmail).toBe("notetaker@meet.acme.com");
    expect(settings.email.senderEmail).toBe("notes@acme.com");
  });

  it("rejects invalid domains, emails, and urls", () => {
    expect(() =>
      parseSettings({
        ...defaultSettings,
        primaryDomain: "not a domain",
        recorderEmail: "invalid",
        attendee: { ...defaultSettings.attendee, baseUrl: "nope" }
      })
    ).toThrow();
  });

  it("keeps secret statuses as booleans only", () => {
    const settings = parseSettings({
      ...defaultSettings,
      attendee: { ...defaultSettings.attendee, apiKeyConfigured: true, webhookSecretConfigured: true },
      ai: { ...defaultSettings.ai, apiKeyConfigured: true }
    });

    expect(settings.attendee.apiKeyConfigured).toBe(true);
    expect(settings.attendee.webhookSecretConfigured).toBe(true);
    expect(settings.ai.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain("sk-");
  });

  it("includes default recap settings with configurable transcription and ordered sections", () => {
    const settings = parseSettings(defaultSettings);

    expect(settings.recap.transcriptionModel).toBe("openai/whisper-large-v3");
    expect(settings.recap.language).toBe("");
    expect(settings.recap.subjectPrefix).toBe("Meeting recap");
    expect(settings.recap.sections.map((section) => section.key)).toEqual([
      "summary",
      "decisions",
      "actionItems",
      "openQuestions",
      "risks",
      "followUps"
    ]);
    expect(settings.recap.sections.every((section) => section.enabled)).toBe(true);
    expect(settings.recap.prompt).toContain("Return strict JSON only");
  });

  it("normalizes recap section order and rejects unknown recap sections", () => {
    const settings = parseSettings({
      ...defaultSettings,
      recap: {
        ...defaultSettings.recap,
        sections: [
          { key: "actionItems", label: "Action items", enabled: true },
          { key: "summary", label: "Summary", enabled: false }
        ]
      }
    });

    expect(settings.recap.sections.map((section) => section.key)).toEqual([
      "actionItems",
      "summary",
      "decisions",
      "openQuestions",
      "risks",
      "followUps"
    ]);
    expect(settings.recap.sections.find((section) => section.key === "summary")?.enabled).toBe(false);
    expect(() =>
      parseSettings({
        ...defaultSettings,
        recap: {
          ...defaultSettings.recap,
          sections: [{ key: "madeUp", label: "Made up", enabled: true }]
        }
      })
    ).toThrow();
  });
});
