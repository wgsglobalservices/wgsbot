import { getSettings, saveSettings } from "@minutesbot/db";
import { AppError, parseSettings, resolveBotBaseUrl, type AppSettings } from "@minutesbot/shared";
import type { Env } from "../env";

const botImageContentTypes = new Set(["image/png", "image/jpeg"]);
const MAX_BOT_IMAGE_BYTES = 5 * 1024 * 1024;

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
  if (bytes.byteLength > MAX_BOT_IMAGE_BYTES) {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image must be 5 MB or smaller.", 413);
  }
  if (!matchesImageSignature(bytes, input.contentType)) {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image bytes do not match the declared file type.");
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

function matchesImageSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return false;
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
