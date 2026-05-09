import { getSettings, saveSettings } from "@minutesbot/db";
import { AppError, parseSettings, resolveBotBaseUrl, type AppSettings } from "@minutesbot/shared";
import type { Env } from "../env";

const botImageContentTypes = new Set(["image/png", "image/jpeg"]);

export async function readSettings(env: Env): Promise<AppSettings> {
  const settings = await getSettings(env.DB);
  return {
    ...settings,
    attendee: {
      ...settings.attendee,
      baseUrl: resolveBotBaseUrl(settings.attendee.baseUrl, env.BOT_API_BASE_URL)
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

export async function uploadBotImage(
  env: Env,
  input: { contentType: string; data: string; fileName?: string }
): Promise<AppSettings> {
  if (!botImageContentTypes.has(input.contentType)) {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image must be a PNG or JPEG.");
  }

  const extension = input.contentType === "image/png" ? "png" : "jpg";
  const r2Key = `settings/meeting-bot-image.${extension}`;
  const bytes = base64ToBytes(input.data);
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
