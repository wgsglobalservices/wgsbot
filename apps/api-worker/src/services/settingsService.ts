import { z } from "zod";
import { getSettings, saveSettings } from "@minutesbot/db";
import { AppError, parseSettings, type AppSettings } from "@minutesbot/shared";
import type { Env } from "../env";

const botImageContentTypes = new Set(["image/png", "image/jpeg"]);
const MAX_BOT_IMAGE_BYTES = 5 * 1024 * 1024;

const botImageInputSchema = z.object({
  contentType: z.string(),
  data: z.string(),
  fileName: z.string().max(255).optional()
});

export type SettingsView = {
  settings: AppSettings;
  /** Presence flags only — secret values never leave the worker. */
  secrets: {
    aiKeyConfigured: boolean;
    transcriptionKeyConfigured: boolean;
    botInternalTokenConfigured: boolean;
    sessionSecretConfigured: boolean;
  };
};

export async function readSettings(env: Env): Promise<SettingsView> {
  const settings = await getSettings(env.DB);
  return {
    settings: {
      ...settings,
      transcription: { ...settings.transcription, apiKeyConfigured: Boolean(env.TRANSCRIPTION_API_KEY ?? env.AI_API_KEY) },
      recap: { ...settings.recap, apiKeyConfigured: Boolean(env.AI_API_KEY) }
    },
    secrets: {
      aiKeyConfigured: Boolean(env.AI_API_KEY),
      transcriptionKeyConfigured: Boolean(env.TRANSCRIPTION_API_KEY ?? env.AI_API_KEY),
      botInternalTokenConfigured: Boolean(env.BOT_INTERNAL_TOKEN),
      sessionSecretConfigured: Boolean(env.SESSION_SECRET)
    }
  };
}

export async function writeSettings(env: Env, input: unknown): Promise<SettingsView> {
  const parsed = parseSettings(input);
  await saveSettings(env.DB, {
    ...parsed,
    transcription: { ...parsed.transcription, apiKeyConfigured: false },
    recap: { ...parsed.recap, apiKeyConfigured: false }
  });
  return readSettings(env);
}

export async function uploadBotImage(env: Env, rawInput: unknown): Promise<SettingsView> {
  const parsedInput = botImageInputSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image upload payload is invalid.");
  }
  const input = parsedInput.data;
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
    bot: {
      ...current.bot,
      image: {
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
