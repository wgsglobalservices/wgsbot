import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { ATTENDEE_WEBHOOK_TRIGGERS, verifyAttendeeWebhookSignature } from "@minutesbot/attendee-client";
import { AppError } from "@minutesbot/shared";
import type { Env } from "../env";
import { processAttendeeWebhook } from "../services/meetingService";

const payloadSchema = z.object({
  idempotency_key: z.string().trim().min(1),
  bot_id: z.string(),
  bot_metadata: z.object({ minutesbot_meeting_id: z.string().optional(), calendar_uid: z.string().optional() }).optional(),
  trigger: z.enum(ATTENDEE_WEBHOOK_TRIGGERS),
  data: z.record(z.unknown())
});

async function handleAttendeeWebhook(c: Context<{ Bindings: Env }>) {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    throw new AppError("WEBHOOK_TOO_LARGE", "Attendee webhook payload is too large.", 413);
  }
  const rawBody = await c.req.text();
  if (!c.env.ATTENDEE_WEBHOOK_SECRET) throw new AppError("WEBHOOK_SECRET_NOT_CONFIGURED", "Configure ATTENDEE_WEBHOOK_SECRET before accepting Attendee webhooks.", 503);
  const valid = await verifyAttendeeWebhookSignature({
    rawBody,
    webhookSecretBase64: c.env.ATTENDEE_WEBHOOK_SECRET,
    signature: c.req.header("x-webhook-signature") ?? null
  });
  if (!valid) throw new AppError("INVALID_WEBHOOK_SIGNATURE", "Invalid Attendee webhook signature", 401);
  const payload = payloadSchema.parse(JSON.parse(rawBody));
  return c.json({ ok: true, ...(await processAttendeeWebhook(c.env, payload)) });
}

export const attendeeWebhookRoute = new Hono<{ Bindings: Env }>().post("/", handleAttendeeWebhook).post("", handleAttendeeWebhook);
