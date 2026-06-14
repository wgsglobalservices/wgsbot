import { describe, expect, it } from "vitest";
import { defaultRecapModel, defaultSettings, defaultTranscriptionModel, parseSettings } from "./validation";

describe("settings validation", () => {
  it("normalizes domains and emails", () => {
    const settings = parseSettings({
      ...defaultSettings,
      allowedDomains: ["AcMe.COM", "acme.com"],
      recorderEmail: "NoteTaker@Meet.AcMe.COM",
      recorderAliasEmails: ["SalesNotes@Meet.AcMe.COM", "notetaker@meet.acme.com", "SalesNotes@meet.acme.com"],
      email: { ...defaultSettings.email, senderName: "  Company Notes  ", senderEmail: "Notes@AcMe.COM" }
    });

    expect(settings.allowedDomains).toEqual(["acme.com"]);
    expect(settings.recorderEmail).toBe("notetaker@meet.acme.com");
    expect(settings.recorderAliasEmails).toEqual(["salesnotes@meet.acme.com"]);
    expect(settings.email.senderName).toBe("Company Notes");
    expect(settings.email.senderEmail).toBe("notes@acme.com");
  });

  it("rejects bare TLD allowed domains", () => {
    expect(() => parseSettings({ ...defaultSettings, allowedDomains: ["com"] })).toThrow();
  });

  it("rejects header injection in sender name and subject prefix", () => {
    expect(() =>
      parseSettings({ ...defaultSettings, email: { ...defaultSettings.email, senderName: "Notes\r\nBcc: evil@example.com" } })
    ).toThrow();
    expect(() => parseSettings({ ...defaultSettings, recap: { ...defaultSettings.recap, subjectPrefix: "Recap\nX-Test: 1" } })).toThrow();
  });

  it("defaults transcription to Whisper and recap to GPT-5.5", () => {
    const minimal = parseSettings({
      companyName: "Acme",
      recorderEmail: "notetaker@acme.com",
      allowedDomains: ["acme.com"],
      email: { provider: "mock", senderEmail: "notetaker@acme.com" },
      policy: {
        sendToAllowedDomainsOnly: true,
        sendToExternalAttendees: false,
        allowSubdomains: false,
        rejectExternalOrganizers: true,
        requireAtLeastOneEligibleRecipient: true
      },
      retention: { rawInviteDays: 30, transcriptDays: 90, summaryDays: 365, auditLogDays: 365 }
    });
    expect(minimal.transcription.provider).toBe("openai-whisper");
    expect(minimal.transcription.model).toBe(defaultTranscriptionModel);
    expect(minimal.recap.model).toBe(defaultRecapModel);
    expect(minimal.bot.joinLeadMinutes).toBe(5);
    expect(minimal.scheduling.recurrenceExpansionDays).toBe(180);
    expect(minimal.policy.distribution).toBe("all_eligible");
    expect(minimal.policy.requireAuthenticatedSender).toBe(true);
    expect(minimal.retention.recordingDays).toBe(30);
  });

  it("rejects any attempt to widen recap delivery beyond allowed domains", () => {
    expect(() =>
      parseSettings({ ...defaultSettings, policy: { ...defaultSettings.policy, sendToAllowedDomainsOnly: false } })
    ).toThrow();
    expect(() =>
      parseSettings({ ...defaultSettings, policy: { ...defaultSettings.policy, sendToExternalAttendees: true } })
    ).toThrow();
  });

  it("validates time zones and bot limits", () => {
    expect(() => parseSettings({ ...defaultSettings, timeZone: "Mars/Olympus" })).toThrow();
    expect(parseSettings({ ...defaultSettings, timeZone: "America/New_York" }).timeZone).toBe("America/New_York");
    expect(() => parseSettings({ ...defaultSettings, bot: { ...defaultSettings.bot, maxMeetingDurationMinutes: 5000 } })).toThrow();
    expect(() => parseSettings({ ...defaultSettings, bot: { ...defaultSettings.bot, joinLeadMinutes: -1 } })).toThrow();
  });

  it("keeps secret presence as booleans only", () => {
    const parsed = parseSettings(defaultSettings);
    expect(parsed.transcription.apiKeyConfigured).toBe(false);
    expect(parsed.recap.apiKeyConfigured).toBe(false);
    expect(JSON.stringify(parsed)).not.toMatch(/apiKey"/);
  });
});
