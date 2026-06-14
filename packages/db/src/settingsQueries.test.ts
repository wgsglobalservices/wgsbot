import { describe, expect, it } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { getSettings, saveSettings } from "./settingsQueries";

class MemoryD1 {
  rows = new Map<string, string>();
  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first<T>() {
        if (sql.includes("FROM settings")) {
          const key = this.values[0] as string;
          const value = db.rows.get(key);
          return value ? ({ key, value, updated_at: new Date().toISOString() } as T) : null;
        }
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT OR REPLACE INTO settings")) {
          db.rows.set(this.values[0] as string, this.values[1] as string);
        }
        return { success: true };
      }
    };
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

describe("settings queries", () => {
  it("returns defaults when settings are absent and persists normalized settings", async () => {
    const db = new MemoryD1() as unknown as D1Database;
    await expect(getSettings(db)).resolves.toEqual(defaultSettings);

    const saved = await saveSettings(db, { ...defaultSettings, primaryDomain: "AcMe.COM", allowedDomains: ["AcMe.COM"] });
    expect(saved.primaryDomain).toBe("acme.com");
    await expect(getSettings(db)).resolves.toMatchObject({ primaryDomain: "acme.com" });
  });

  it("loads legacy settings rows with long transcript download expirations", async () => {
    const db = new MemoryD1();
    db.rows.set(
      "app",
      JSON.stringify({
        ...defaultSettings,
        recap: {
          ...defaultSettings.recap,
          transcriptDownloadExpirationHours: 168
        }
      })
    );

    await expect(getSettings(db as unknown as D1Database)).resolves.toMatchObject({
      recap: { transcriptDownloadExpirationHours: 24 }
    });
  });

  it("loads the legacy setup settings shape saved before attendee and ai settings were split", async () => {
    const db = new MemoryD1();
    db.rows.set(
      "app",
      JSON.stringify({
        companyName: "WGS Global Services",
        timeZone: "America/Detroit",
        recorderEmail: "notetaker@wgs.bot",
        recorderAliasEmails: ["note@wgs.bot"],
        allowedDomains: ["wgsglobalservices.com"],
        bot: {
          displayName: "Notetaker (wgsbot)",
          joinLeadMinutes: 5,
          maxWaitingRoomMinutes: 15,
          maxMeetingDurationMinutes: 240,
          maxJoinAttempts: 2
        },
        transcription: {
          provider: "openai-whisper",
          model: "whisper-1",
          apiKeyConfigured: false
        },
        recap: {
          provider: "openai-compatible",
          model: "gpt-5.5",
          subjectPrefix: "Meeting recap",
          introText: "",
          apiKeyConfigured: false
        },
        email: {
          provider: "cloudflare-email-service",
          senderName: "Notetaker (wgsbot)",
          senderEmail: "notetaker@wgs.bot"
        },
        policy: {
          sendToAllowedDomainsOnly: true,
          sendToExternalAttendees: false,
          allowSubdomains: false,
          distribution: "all_eligible",
          rejectExternalOrganizers: true,
          requireAtLeastOneEligibleRecipient: true,
          requireAuthenticatedSender: true
        },
        scheduling: {
          recurrenceExpansionDays: 180,
          staleSessionMinutes: 10
        },
        retention: {
          rawInviteDays: 30,
          recordingDays: 30,
          transcriptDays: 30,
          summaryDays: 365,
          auditLogDays: 365,
          diagnosticsDays: 30
        }
      })
    );

    await expect(getSettings(db as unknown as D1Database)).resolves.toMatchObject({
      companyName: "WGS Global Services",
      primaryDomain: "wgsglobalservices.com",
      allowedDomains: ["wgsglobalservices.com"],
      recorderEmail: "notetaker@wgs.bot",
      attendee: {
        baseUrl: defaultSettings.attendee.baseUrl,
        botName: "Notetaker (wgsbot)",
        createBotMinutesBeforeStart: 5,
        maxWaitingRoomMinutes: 15
      },
      ai: {
        provider: "openai-compatible",
        model: "gpt-5.5",
        apiKeyConfigured: false
      },
      email: {
        provider: "cloudflare-email-service",
        senderEmail: "notetaker@wgs.bot",
        sendMeetingRecapsAutomatically: false
      },
      recap: {
        transcriptionModel: "whisper-1",
        subjectPrefix: "Meeting recap",
        introText: ""
      },
      retention: {
        rawInviteDays: 30,
        transcriptDays: 30,
        summaryDays: 365,
        auditLogDays: 365,
        attendeeDeleteDataAfterDays: 0
      }
    });
  });
});
