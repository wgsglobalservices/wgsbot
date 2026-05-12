import { getSettings, saveSettings } from "@minutesbot/db";
import { AppError, parseSettings, resolveAttendeeBaseUrl, type AppSettings } from "@minutesbot/shared";
import type { Env } from "../env";

const botImageContentTypes = new Set(["image/png", "image/jpeg"]);
const maxBotImageBytes = 2_000_000;

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
  assertApprovedProviderUrls(env, parsed);
  await saveSettings(env.DB, {
    ...parsed,
    ai: {
      ...parsed.ai,
      apiKeyConfigured: false
    }
  });
  return readSettings(env);
}

export async function uploadBotImage(
  env: Env,
  input: { contentType: string; data: string; fileName?: string }
): Promise<AppSettings> {
  if (!botImageContentTypes.has(input.contentType)) {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image must be a PNG or JPEG.");
  }

  const extension = input.contentType === "image/png" ? "png" : "jpg";
  const r2Key = `settings/attendee-bot-image.${extension}`;
  const bytes = base64ToBytes(input.data);
  if (bytes.byteLength > maxBotImageBytes) {
    throw new AppError("BOT_IMAGE_TOO_LARGE", "Bot image must be 2 MB or smaller after compression.", 413);
  }
  await env.ARTIFACTS.put(r2Key, bytes, {
    httpMetadata: { contentType: input.contentType },
    customMetadata: input.fileName ? { fileName: input.fileName } : undefined
  });

  const current = await getSettings(env.DB);
  await saveSettings(env.DB, {
    ...current,
    attendee: {
      ...current.attendee,
      botImage: {
        r2Key,
        contentType: input.contentType as "image/png" | "image/jpeg",
        fileName: input.fileName,
        uploadedAt: new Date().toISOString()
      }
    }
  });
  return readSettings(env);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image data must be valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assertApprovedProviderUrls(env: Env, settings: AppSettings): void {
  assertApprovedUrl("Attendee base URL", settings.attendee.baseUrl, [
    "https://app.attendee.dev",
    "https://attendee.wgsglobal.app",
    "https://attendee.wgs.bot",
    env.ATTENDEE_API_BASE_URL,
    ...(env.ATTENDEE_BASE_URL_ALLOWLIST ?? "").split(",")
  ]);
  if (settings.ai.baseUrl) {
    assertApprovedUrl("AI base URL", settings.ai.baseUrl, [
      "https://api.openai.com",
      "https://api.openai.com/v1",
      "https://openrouter.ai",
      "https://openrouter.ai/api/v1",
      ...(env.AI_BASE_URL_ALLOWLIST ?? "").split(",")
    ]);
  }
}

function assertApprovedUrl(label: string, value: string, allowedValues: Array<string | undefined>): void {
  const normalized = normalizeProviderUrl(value);
  const allowed = new Set(
    allowedValues
      .map((item) => normalizeProviderUrl(item ?? ""))
      .filter((item): item is URL => Boolean(item))
      .map(providerKey)
  );
  if (!normalized || normalized.protocol !== "https:" || isBlockedProviderHost(normalized.hostname) || !allowed.has(providerKey(normalized))) {
    throw new AppError("UNAPPROVED_PROVIDER_URL", `${label} is not in the approved provider allowlist.`, 400);
  }
}

function normalizeProviderUrl(value: string): URL | null {
  try {
    return new URL(value.trim().replace(/\/+$/, ""));
  } catch {
    return null;
  }
}

function providerKey(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function isBlockedProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "0.0.0.0" || host === "127.0.0.1" || host === "::1" || host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}
