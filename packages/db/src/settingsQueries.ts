import { defaultSettings, nowIso, parseSettings, type AppSettings } from "@minutesbot/shared";
import type { SettingRow } from "./schema";

const SETTINGS_KEY = "app";

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const row = await db.prepare("SELECT key, value, updated_at FROM settings WHERE key = ?").bind(SETTINGS_KEY).first<SettingRow>();
  if (!row) return defaultSettings;
  return parseSettings(normalizeStoredSettings(JSON.parse(row.value)));
}

export async function saveSettings(db: D1Database, settings: AppSettings): Promise<AppSettings> {
  const parsed = parseSettings(settings);
  await db
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(SETTINGS_KEY, JSON.stringify(parsed), nowIso())
    .run();
  await replaceAllowedDomains(db, parsed.allowedDomains);
  return parsed;
}

async function replaceAllowedDomains(db: D1Database, domains: string[]): Promise<void> {
  // Batched so a mid-write failure cannot leave the allowlist empty.
  await db.batch([
    db.prepare("DELETE FROM allowed_domains"),
    ...domains.map((domain) => db.prepare("INSERT INTO allowed_domains (id, domain, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), domain, nowIso()))
  ]);
}

function normalizeStoredSettings(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const settings = upgradeLegacySetupSettings(input as Record<string, unknown>);
  if (!settings.recap || typeof settings.recap !== "object" || Array.isArray(settings.recap)) return settings;

  const recap = settings.recap as Record<string, unknown>;
  const maxExpirationHours = defaultSettings.recap.transcriptDownloadExpirationHours;
  if (
    typeof recap.transcriptDownloadExpirationHours !== "number" ||
    !Number.isFinite(recap.transcriptDownloadExpirationHours) ||
    recap.transcriptDownloadExpirationHours <= maxExpirationHours
  ) {
    return settings;
  }

  return {
    ...settings,
    recap: {
      ...recap,
      transcriptDownloadExpirationHours: maxExpirationHours
    }
  };
}

function upgradeLegacySetupSettings(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.primaryDomain && settings.attendee && settings.ai) return settings;

  const bot = recordValue(settings.bot);
  const transcription = recordValue(settings.transcription);
  const legacyRecap = recordValue(settings.recap);
  const email = recordValue(settings.email);
  const retention = recordValue(settings.retention);
  const policy = recordValue(settings.policy);
  if (!bot && !transcription && !legacyRecap) return settings;

  const primaryDomain = stringValue(settings.primaryDomain) ?? firstString(settings.allowedDomains) ?? defaultSettings.primaryDomain;
  const allowedDomains = stringArray(settings.allowedDomains);

  return {
    ...settings,
    primaryDomain,
    allowedDomains: allowedDomains.length > 0 ? allowedDomains : [primaryDomain],
    attendee: {
      ...defaultSettings.attendee,
      botName: stringValue(bot?.displayName) ?? defaultSettings.attendee.botName,
      createBotMinutesBeforeStart: numberValue(bot?.joinLeadMinutes) ?? defaultSettings.attendee.createBotMinutesBeforeStart,
      maxWaitingRoomMinutes: numberValue(bot?.maxWaitingRoomMinutes) ?? defaultSettings.attendee.maxWaitingRoomMinutes
    },
    ai: {
      ...defaultSettings.ai,
      provider: providerValue(legacyRecap?.provider, ["openai-compatible", "workers-ai"]) ?? defaultSettings.ai.provider,
      model: stringValue(legacyRecap?.model) ?? defaultSettings.ai.model,
      apiKeyConfigured: booleanValue(legacyRecap?.apiKeyConfigured) ?? defaultSettings.ai.apiKeyConfigured
    },
    email: {
      ...defaultSettings.email,
      provider: providerValue(email?.provider, ["cloudflare-email-service", "smtp", "mock"]) ?? defaultSettings.email.provider,
      senderEmail: stringValue(email?.senderEmail) ?? defaultSettings.email.senderEmail
    },
    policy: {
      ...defaultSettings.policy,
      allowSubdomains: booleanValue(policy?.allowSubdomains) ?? defaultSettings.policy.allowSubdomains,
      rejectExternalOrganizers: booleanValue(policy?.rejectExternalOrganizers) ?? defaultSettings.policy.rejectExternalOrganizers,
      requireAtLeastOneEligibleRecipient: booleanValue(policy?.requireAtLeastOneEligibleRecipient) ?? defaultSettings.policy.requireAtLeastOneEligibleRecipient
    },
    retention: {
      ...defaultSettings.retention,
      rawInviteDays: numberValue(retention?.rawInviteDays) ?? defaultSettings.retention.rawInviteDays,
      transcriptDays: numberValue(retention?.transcriptDays) ?? defaultSettings.retention.transcriptDays,
      summaryDays: numberValue(retention?.summaryDays) ?? defaultSettings.retention.summaryDays,
      auditLogDays: numberValue(retention?.auditLogDays) ?? defaultSettings.retention.auditLogDays
    },
    recap: {
      ...defaultSettings.recap,
      transcriptionModel: stringValue(transcription?.model) ?? defaultSettings.recap.transcriptionModel,
      subjectPrefix: stringValue(legacyRecap?.subjectPrefix) ?? defaultSettings.recap.subjectPrefix,
      introText: stringValue(legacyRecap?.introText) ?? defaultSettings.recap.introText
    }
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  return stringArray(value)[0];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function providerValue<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}
