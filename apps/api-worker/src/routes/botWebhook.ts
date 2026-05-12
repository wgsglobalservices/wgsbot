import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { BOT_WEBHOOK_TRIGGERS } from "@minutesbot/bot-client";
import { AppError, readTextWithLimit, timingSafeEqualString } from "@minutesbot/shared";
import type { Env } from "../env";
import { processBotWebhook } from "../services/meetingService";

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

const payloadSchema = z.object({
  idempotency_key: z.string().optional(),
  bot_id: z.string(),
  bot_metadata: z.object({ minutesbot_meeting_id: z.string().optional(), calendar_uid: z.string().optional() }).optional(),
  trigger: z.enum(BOT_WEBHOOK_TRIGGERS),
  data: z.record(z.unknown())
});

async function handleBotWebhook(c: Context<{ Bindings: Env }>) {
  const expectedToken = c.env.BOT_INTERNAL_TOKEN;
  if (!expectedToken) {
    throw new AppError("BOT_WEBHOOK_AUTH_NOT_CONFIGURED", "Meeting bot webhook authorization is not configured.", 503);
  }
  if (!timingSafeEqualString(c.req.header("authorization") ?? "", `Bearer ${expectedToken}`)) {
    throw new AppError("INVALID_BOT_WEBHOOK_AUTH", "Invalid meeting bot webhook authorization", 401);
  }
  const rawBody = await readTextWithLimit(c.req.raw, MAX_WEBHOOK_BODY_BYTES, "BOT_WEBHOOK_PAYLOAD_TOO_LARGE");
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new AppError("INVALID_BOT_WEBHOOK_PAYLOAD", "Meeting bot webhook body must be valid JSON.", 400);
  }
  const payload = payloadSchema.parse(body);
  return c.json({ ok: true, ...(await processBotWebhook(c.env, payload)) });
}

export const botWebhookRoute = new Hono<{ Bindings: Env }>().post("/", handleBotWebhook).post("", handleBotWebhook);
