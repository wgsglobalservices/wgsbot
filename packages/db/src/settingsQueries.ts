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
  const settings = input as Record<string, unknown>;
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
