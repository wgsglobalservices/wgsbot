import { Hono } from "hono";
import { AttendeeClient } from "@minutesbot/attendee-client";
import { parseIncomingInvite } from "@minutesbot/invite-parser";
import { renderSummaryEmail } from "@minutesbot/email-renderer";
import { createOpenAiCompatibleProvider } from "@minutesbot/summary-engine";
import { defaultSettings } from "@minutesbot/shared";
import type { Env } from "../env";
import { readSettings } from "../services/settingsService";

const sampleInvite = `From: Alice <alice@wgs.bot>
To: notetaker@wgs.bot
Subject: Test

BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:test
SUMMARY:Test
DTSTART:20260504T150000Z
DTEND:20260504T153000Z
ORGANIZER;CN=Alice:mailto:alice@wgs.bot
ATTENDEE;CN=Alex;ROLE=REQ-PARTICIPANT:mailto:alex@wgs.bot
DESCRIPTION:https://teams.microsoft.com/l/meetup-join/19%3atest%40thread.v2/0?context=%7b%7d
END:VEVENT
END:VCALENDAR`;

export const testActionsRoute = new Hono<{ Bindings: Env }>()
  .get("/status", async (c) => {
    const settings = await readSettings(c.env);
    return c.json({
      ok: true,
      environment: c.env.ENVIRONMENT,
      attendee: {
        baseUrl: settings.attendee.baseUrl,
        apiKeyConfigured: settings.attendee.apiKeyConfigured,
        webhookSecretConfigured: settings.attendee.webhookSecretConfigured
      },
      webhookUrl: `${c.env.API_BASE_URL}/api/webhooks/attendee`
    });
  })
  .post("/test-d1", async (c) => {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, message: "D1 query succeeded" });
  })
  .post("/test-r2", async (c) => {
    const key = `admin-tests/${crypto.randomUUID()}.txt`;
    await c.env.ARTIFACTS.put(key, "ok");
    await c.env.ARTIFACTS.delete(key);
    return c.json({ ok: true, message: "R2 put/delete succeeded" });
  })
  .post("/test-attendee", async (c) => {
    const settings = await readSettings(c.env);
    if (!c.env.ATTENDEE_API_KEY) return c.json({ ok: false, message: "ATTENDEE_API_KEY secret is not configured" }, 400);
    const client = new AttendeeClient({ baseUrl: settings.attendee.baseUrl, apiKey: c.env.ATTENDEE_API_KEY });
    return c.json({ ok: true, preview: { clientBaseUrl: settings.attendee.baseUrl, createBotPayload: { meeting_url: "<teams-url>", bot_name: settings.attendee.botName } } });
  })
  .post("/test-ai", async (c) => {
    const settings = await readSettings(c.env);
    if (!c.env.AI_API_KEY) return c.json({ ok: false, message: "AI_API_KEY secret is not configured" }, 400);
    if (settings.ai.provider !== "openai-compatible") {
      return c.json({ ok: false, message: "Only OpenAI-compatible AI connection tests are supported in this MVP" }, 400);
    }

    const provider = createOpenAiCompatibleProvider({
      baseUrl: settings.ai.baseUrl || defaultSettings.ai.baseUrl || "https://api.openai.com/v1",
      apiKey: c.env.AI_API_KEY,
      model: settings.ai.model
    });
    await provider.generate("Return exactly this JSON object and no extra text: {\"ok\":true}");

    return c.json({
      ok: true,
      message: "AI provider connection succeeded",
      provider: {
        type: settings.ai.provider,
        baseUrl: settings.ai.baseUrl,
        model: settings.ai.model
      }
    });
  })
  .post("/test-email", async (c) => c.json({ ok: true, message: "Outbound email provider is configured as mock unless a binding/provider is supplied" }))
  .post("/parse-sample-invite", async (c) => c.json({ ok: true, invite: parseIncomingInvite(sampleInvite) }))
  .post("/send-test-summary-email", async (c) =>
    c.json({
      ok: true,
      email: renderSummaryEmail({
        subject: "Test summary",
        summary: { summary: ["Test email rendered."], decisions: [], actionItems: [], openQuestions: [], risks: [], followUps: [] }
      })
    })
  )
  .post("/verify-webhook-signature-sample", async (c) =>
    c.json({ ok: true, message: "Use ATTENDEE_WEBHOOK_SECRET and X-Webhook-Signature against /api/webhooks/attendee for live verification" })
  );
