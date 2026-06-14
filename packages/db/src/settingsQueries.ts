import { createId, defaultSettings, nowIso, parseSettings, type AppSettings } from "@minutesbot/shared";
import type { AllowedDomainRow, SettingRow } from "./schema";

const SETTINGS_KEY = "app";

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const row = await db.prepare("SELECT key, value, updated_at FROM settings WHERE key = ?").bind(SETTINGS_KEY).first<SettingRow>();
  if (!row) return defaultSettings;
  return parseSettings(JSON.parse(row.value));
}

export async function saveSettings(db: D1Database, settings: AppSettings): Promise<AppSettings> {
  const parsed = parseSettings(settings);
  await db
    .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(SETTINGS_KEY, JSON.stringify(parsed), nowIso())
    .run();
  await replaceAllowedDomains(db, parsed.allowedDomains, parsed.policy.allowSubdomains);
  return parsed;
}

/**
 * Mirrors the allowlist into its own table so the send boundary can enforce
 * policy with one indexed lookup. Batched so a mid-write failure cannot
 * leave the allowlist empty.
 */
async function replaceAllowedDomains(db: D1Database, domains: string[], allowSubdomains: boolean): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM allowed_domains"),
    ...domains.map((domain) =>
      db
        .prepare("INSERT INTO allowed_domains (id, domain, allow_subdomains, enabled, created_at) VALUES (?, ?, ?, 1, ?)")
        .bind(createId("dom"), domain, allowSubdomains ? 1 : 0, nowIso())
    )
  ]);
}

export async function listAllowedDomains(db: D1Database): Promise<AllowedDomainRow[]> {
  const result = await db.prepare("SELECT * FROM allowed_domains WHERE enabled = 1 ORDER BY domain").all<AllowedDomainRow>();
  return result.results ?? [];
}
