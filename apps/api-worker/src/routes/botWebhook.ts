import { Hono } from "hono";
import type { Context } from "hono";
import { botWebhookPayloadSchema } from "@minutesbot/bot-client";
import { AppError, readTextWithLimit, timingSafeEqualString } from "@minutesbot/shared";
import { processBotWebhook } from "../../../workflow-worker/src/botWebhookProcessor";
import type { Env } from "../env";

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

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
  const parsed = botWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("INVALID_BOT_WEBHOOK_PAYLOAD", "Meeting bot webhook payload failed validation.", 400);
  }
  const result = await processBotWebhook(c.env, parsed.data);
  // Unknown/superseded sessions return 200 so a zombie runtime doesn't
  // retry-loop forever; the result body records why nothing was applied.
  return c.json(result);
}

export const botWebhookRoute = new Hono<{ Bindings: Env }>().post("/", handleBotWebhook).post("", handleBotWebhook);
