import { getSettings, saveSettings } from "@minutesbot/db";
import { parseSettings, resolveAttendeeBaseUrl, type AppSettings } from "@minutesbot/shared";
import type { Env } from "../env";

export async function readSettings(env: Env): Promise<AppSettings> {
  const settings = await getSettings(env.DB);
  return {
    ...settings,
    attendee: {
      ...settings.attendee,
      baseUrl: resolveAttendeeBaseUrl(settings.attendee.baseUrl, env.ATTENDEE_API_BASE_URL),
      apiKeyConfigured: Boolean(env.ATTENDEE_API_KEY) || settings.attendee.apiKeyConfigured,
      webhookSecretConfigured: Boolean(env.ATTENDEE_WEBHOOK_SECRET) || settings.attendee.webhookSecretConfigured
    },
    ai: {
      ...settings.ai,
      apiKeyConfigured: Boolean(env.AI_API_KEY)
    }
  };
}

export async function writeSettings(env: Env, input: unknown): Promise<AppSettings> {
  const parsed = parseSettings(input);
  await saveSettings(env.DB, {
    ...parsed,
    ai: {
      ...parsed.ai,
      apiKeyConfigured: false
    }
  });
  return readSettings(env);
}
