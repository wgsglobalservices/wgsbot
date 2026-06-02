import { describe, expect, it } from "vitest";
import { defaultRecapPrompt, defaultSampleRecapRecipient, defaultSettings, parseSettings, weeklySalesRecapEmail } from "./validation";

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
    expect(settings.recorderAliasEmails).toEqual(["salesnotes@meet.acme.com", weeklySalesRecapEmail]);
    expect(settings.email.senderEmail).toBe("notes@acme.com");
  });

  it("defaults legacy settings to the weekly sales recap alias", () => {
    const legacySettings: Partial<typeof defaultSettings> = { ...defaultSettings };
    delete legacySettings.recorderAliasEmails;

    expect(parseSettings(legacySettings).recorderAliasEmails).toEqual([weeklySalesRecapEmail]);
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
    expect(settings.recap.classificationEnabled).toBe(false);
    expect(settings.recap.defaultTemplate).toBe("general");
    expect(settings.recap.enabledTemplates).toEqual(["general"]);
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
    expect(settings.recap.prompt).toContain("The recap must work for any meeting type");
    expect(settings.recap.prompt).toContain("Primary objective:");
    expect(settings.recap.prompt).toContain("Create a layered recap");
    expect(settings.recap.prompt).toContain("Executive Highlights");
    expect(settings.recap.prompt).toContain("Person-Specific Briefs");
    expect(settings.recap.prompt).toContain("Action items are grouped by owner");
    expect(settings.recap.prompt).toContain("Prioritize items involving:");
    expect(settings.recap.prompt).toContain("Full Action Register");
    expect(settings.recap.prompt).toContain("Use \"Not defined\" when no mitigation was discussed");
    expect(settings.recap.prompt).toContain("Clean up unclear speaker labels");
    expect(settings.recap.prompt).toContain("Recommended generic detail topics");
    expect(settings.recap.prompt).toContain("For sales or customer-development meetings");
    expect(settings.recap.prompt).not.toContain("automatically classifies meetings into Weekly SPQRC");
    expect(settings.recap.prompt).not.toContain("For Weekly Sales meetings");
  });

  it("accepts long built-in WGS recap prompt instructions", () => {
    const prompt = "Detailed WGS recap instruction. ".repeat(650);

    expect(
      parseSettings({
        ...defaultSettings,
        recap: {
          ...defaultSettings.recap,
          prompt
        }
      }).recap.prompt
    ).toBe(prompt.trim());
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

  it("adds universal recap defaults to legacy recap settings", () => {
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

    expect(settings.recap.classificationEnabled).toBe(false);
    expect(settings.recap.defaultTemplate).toBe("general");
    expect(settings.recap.enabledTemplates).toEqual(["general"]);
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
    const previousBuiltInPrompt = [
      "You generate WGS meeting recaps from Microsoft Teams meeting titles and transcripts. Return strict JSON only.",
      "Generate one unified WGS / MinutesBot meeting recap in executive recap format using this structure: # {Meeting Name} — Executive Recap, meeting date/time, AI-generated recap notice, 1. At a Glance, 2. Detailed Recap, 3. Full Action Register, 4. Open Questions, and 5. Reference Notes.",
      "In At a Glance, put the most important business items first. Rank top priorities by customer blockers, revenue or collections, quote activity, staffing or capacity risks, decisions, named-owner or near-term actions, delivery risks, and blocking open questions.",
      "Use an Immediate Actions table with columns Priority, Action, Owner, Due, Related Customer / Area, and Status. Merge duplicate actions and list no more than 10 immediate actions.",
      "Separate actual decisions from action items. Separate risks and blockers from open questions.",
      "For Detailed Recap, organize by business topic rather than transcript order. Use only relevant sections from Customer Work & Sales Pipeline, Staffing, Capacity & Operations, Reporting, CRM & Tracking, Documentation & Process Control, Financial / Pricing / Contract Items, and Wins & Progress.",
      "For the Full Action Register, preserve all concrete deduplicated tasks with owner, due date, priority, related area, and notes.",
      "The renderer displays this disclaimer at the top: Generated by AI. Be sure to check for accuracy. Do not include this disclaimer in any JSON field.",
      "wgsbot automatically classifies meetings into Weekly SPQRC, Weekly Sales, Individual Plant Meeting, and General before generating the recap.",
      "Use the resolved meeting type supplied by the classifier and do not reclassify during recap generation.",
      "For standard recaps, preserve important meeting metadata such as meeting title, date, and weekly focus when stated. Do not emit repeated Weekly Summary sections or organize by transcript chunk.",
      "Clean up unclear speaker labels such as \"Conference Room Computer\". Attribute to a named speaker only when the transcript supports it; otherwise write without that speaker label.",
      "Do not invent facts, owners, due dates, decisions, risks, metrics, customer names, plant names, or follow-ups.",
      "If something is unclear, say \"Unclear\". If something is not mentioned, say \"Not specified\". If there are no items for a field, return an empty array.",
      "Action items must include owner, task, and dueDate. Use owner \"Unassigned\" and dueDate \"TBD\" when not specified.",
      "Only include confirmed decisions, agreements, approvals, rejected options, committed plans, or direction changes.",
      "Capture blockers, delays, safety, quality, delivery, cost, customer, revenue, staffing, equipment, material, and dependency risks.",
      "Capture unresolved questions, missing information, unclear ownership, unclear deadlines, pending customer answers, and pending plant data.",
      "Capture planned future meetings, customer follow-ups, plant check-ins, internal reviews, reports to prepare, data to validate, and next-week topics."
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
        recap: { ...defaultSettings.recap, prompt: previousBuiltInPrompt }
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
