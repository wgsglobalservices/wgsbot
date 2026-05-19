import { describe, expect, it } from "vitest";
import { defaultRecapPrompt, defaultSampleRecapRecipient, defaultSettings, parseSettings } from "./validation";

describe("settings validation", () => {
  it("normalizes domains and emails", () => {
    const settings = parseSettings({
      ...defaultSettings,
      primaryDomain: "AcMe.COM",
      allowedDomains: ["AcMe.COM", "acme.com"],
      recorderEmail: "NoteTaker@Meet.AcMe.COM",
      recorderAliasEmails: ["SalesNotes@Meet.AcMe.COM", "notetaker@meet.acme.com", "SalesNotes@meet.acme.com"],
      email: { ...defaultSettings.email, senderEmail: "Notes@AcMe.COM" }
    });

    expect(settings.primaryDomain).toBe("acme.com");
    expect(settings.allowedDomains).toEqual(["acme.com"]);
    expect(settings.recorderEmail).toBe("notetaker@meet.acme.com");
    expect(settings.recorderAliasEmails).toEqual(["salesnotes@meet.acme.com"]);
    expect(settings.email.senderEmail).toBe("notes@acme.com");
  });

  it("defaults legacy settings to no recorder aliases", () => {
    const legacySettings: Partial<typeof defaultSettings> = { ...defaultSettings };
    delete legacySettings.recorderAliasEmails;

    expect(parseSettings(legacySettings).recorderAliasEmails).toEqual([]);
  });

  it("defaults legacy settings to UTC and validates configured time zones", () => {
    const legacySettings: Partial<typeof defaultSettings> = { ...defaultSettings };
    delete legacySettings.timeZone;

    expect(parseSettings(legacySettings).timeZone).toBe("UTC");
    expect(parseSettings({ ...defaultSettings, timeZone: "America/Detroit" }).timeZone).toBe("America/Detroit");
    expect(() => parseSettings({ ...defaultSettings, timeZone: "Eastern" })).toThrow();
  });

  it("rejects invalid domains, emails, and urls", () => {
    expect(() =>
      parseSettings({
        ...defaultSettings,
        primaryDomain: "not a domain",
        recorderEmail: "invalid",
        recorderAliasEmails: ["still-invalid"],
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

  it("uses the WGS IT mailbox as the default sample recap recipient", () => {
    expect(defaultSettings.email.testRecipient).toBe(defaultSampleRecapRecipient);
    expect(parseSettings(defaultSettings).email.testRecipient).toBe("it@wgsglobalservices.com");
  });

  it("defaults meeting recap delivery to manual testing mode", () => {
    const legacySettings = JSON.parse(JSON.stringify(defaultSettings)) as typeof defaultSettings;
    delete (legacySettings.email as Partial<typeof defaultSettings.email>).sendMeetingRecapsAutomatically;

    expect(defaultSettings.email.sendMeetingRecapsAutomatically).toBe(false);
    expect(parseSettings(legacySettings).email.sendMeetingRecapsAutomatically).toBe(false);
    expect(parseSettings({ ...defaultSettings, email: { ...defaultSettings.email, sendMeetingRecapsAutomatically: true } }).email.sendMeetingRecapsAutomatically).toBe(true);
  });

  it("keeps bot image storage metadata without storing image bytes in settings", () => {
    const settings = parseSettings({
      ...defaultSettings,
      attendee: {
        ...defaultSettings.attendee,
        botImage: {
          r2Key: "settings/attendee-bot-image.png",
          contentType: "image/png",
          fileName: "wgsbot.png",
          uploadedAt: "2026-05-06T12:00:00.000Z"
        }
      }
    });

    expect(settings.attendee.botImage).toEqual({
      r2Key: "settings/attendee-bot-image.png",
      contentType: "image/png",
      fileName: "wgsbot.png",
      uploadedAt: "2026-05-06T12:00:00.000Z"
    });
    expect(JSON.stringify(settings)).not.toContain("base64");
  });

  it("rejects unsupported bot image metadata content types", () => {
    expect(() =>
      parseSettings({
        ...defaultSettings,
        attendee: {
          ...defaultSettings.attendee,
          botImage: {
            r2Key: "settings/attendee-bot-image.gif",
            contentType: "image/gif",
            fileName: "wgsbot.gif",
            uploadedAt: "2026-05-06T12:00:00.000Z"
          }
        }
      })
    ).toThrow();
  });

  it("includes default recap settings with configurable transcription and ordered sections", () => {
    const settings = parseSettings(defaultSettings);

    expect(settings.recap.transcriptionModel).toBe("openai/whisper-large-v3-turbo");
    expect(settings.recap.language).toBe("");
    expect(settings.recap.subjectPrefix).toBe("Meeting recap");
    expect(settings.recap.classificationEnabled).toBe(true);
    expect(settings.recap.defaultTemplate).toBe("auto");
    expect(settings.recap.enabledTemplates).toEqual(["weekly_spqrc", "weekly_sales", "plant_meeting", "general"]);
    expect(settings.recap.shortMeetingBriefRecapEnabled).toBe(true);
    expect(settings.recap.shortMeetingDurationThresholdMinutes).toBe(2);
    expect(settings.recap.transcriptDownloadExpirationHours).toBe(24);
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
    expect(settings.recap.prompt).toContain("automatically classifies meetings");
    expect(settings.recap.prompt).toContain("WGS / MinutesBot meeting recap");
    expect(settings.recap.prompt).toContain("Executive Summary");
    expect(settings.recap.prompt).toContain("Risks and Blockers");
    expect(settings.recap.prompt).toContain("Weekly SPQRC");
    expect(settings.recap.prompt).toContain("Weekly Sales");
    expect(settings.recap.prompt).toContain("Individual Plant Meeting");
    expect(settings.recap.prompt).toContain("General");
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

  it("adds recap template defaults to legacy recap settings", () => {
    const settings = parseSettings({
      ...defaultSettings,
      recap: {
        transcriptionModel: "openai/whisper-large-v3-turbo",
        language: "",
        prompt: defaultRecapPrompt,
        subjectPrefix: "Meeting recap",
        introText: "",
        sections: defaultSettings.recap.sections
      }
    });

    expect(settings.recap.classificationEnabled).toBe(true);
    expect(settings.recap.defaultTemplate).toBe("auto");
    expect(settings.recap.enabledTemplates).toEqual(["weekly_spqrc", "weekly_sales", "plant_meeting", "general"]);
    expect(settings.recap.shortMeetingBriefRecapEnabled).toBe(true);
    expect(settings.recap.shortMeetingDurationThresholdMinutes).toBe(2);
    expect(settings.recap.transcriptDownloadExpirationHours).toBe(24);
  });

  it("caps transcript download links to one day", () => {
    expect(() =>
      parseSettings({
        ...defaultSettings,
        recap: {
          ...defaultSettings.recap,
          transcriptDownloadExpirationHours: 25
        }
      })
    ).toThrow();
  });

  it("upgrades the legacy built-in recap prompt but preserves custom prompts", () => {
    const legacyPrompt = [
      "You generate meeting recaps from transcripts. Return strict JSON only.",
      "Do not invent facts, owners, due dates, decisions, risks, or follow-ups.",
      "If no decision or action item is present, return an empty array for that field."
    ].join("\n");
    const customPrompt = "Use our internal recap format. Keep concise notes for leadership.";

    expect(
      parseSettings({
        ...defaultSettings,
        recap: { ...defaultSettings.recap, prompt: legacyPrompt }
      }).recap.prompt
    ).toBe(defaultRecapPrompt);
    expect(
      parseSettings({
        ...defaultSettings,
        recap: { ...defaultSettings.recap, prompt: customPrompt }
      }).recap.prompt
    ).toBe(customPrompt);
  });
});
