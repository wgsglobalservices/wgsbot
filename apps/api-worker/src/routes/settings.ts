import { Hono } from "hono";
import { createAuditLog } from "@minutesbot/db";
import { AppError, readJsonWithLimit } from "@minutesbot/shared";
import type { Env } from "../env";
import { readSettings, uploadBotImage, writeSettings } from "../services/settingsService";

const MAX_SETTINGS_BODY_BYTES = 256 * 1024;
// Bot images are limited to 5 MB after base64 decode; allow headroom for encoding.
const MAX_BOT_IMAGE_BODY_BYTES = 8 * 1024 * 1024;

export const settingsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => c.json(await readSettings(c.env)))
  .put("/", async (c) => {
    const settings = await writeSettings(c.env, await readJsonWithLimit(c.req.raw, MAX_SETTINGS_BODY_BYTES));
    await createAuditLog(c.env.DB, { eventType: "settings.changed", resourceType: "settings", resourceId: "app" });
    return c.json(settings);
  })
  .post("/bot-image", async (c) => {
    const settings = await uploadBotImage(c.env, parseBotImageUpload(await readJsonWithLimit(c.req.raw, MAX_BOT_IMAGE_BODY_BYTES)));
    await createAuditLog(c.env.DB, { eventType: "settings.bot_image_uploaded", resourceType: "settings", resourceId: "app" });
    return c.json(settings);
  });

function parseBotImageUpload(input: unknown): { contentType: string; data: string; fileName?: string } {
  if (!input || typeof input !== "object") {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image upload payload is invalid.", 400);
  }
  const payload = input as Record<string, unknown>;
  if (typeof payload.contentType !== "string" || typeof payload.data !== "string") {
    throw new AppError("INVALID_BOT_IMAGE", "Bot image upload payload is invalid.", 400);
  }
  return {
    contentType: payload.contentType,
    data: payload.data,
    fileName: typeof payload.fileName === "string" ? payload.fileName : undefined
  };
}
