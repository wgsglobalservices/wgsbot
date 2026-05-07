import { Hono } from "hono";
import { z } from "zod";
import { AttendeeClient, AttendeeClientError } from "@minutesbot/attendee-client";
import { parseIncomingInvite } from "@minutesbot/invite-parser";
import { renderSummaryEmail } from "@minutesbot/email-renderer";
import { createEmailProvider } from "@minutesbot/email-sender";
import { createOpenAiCompatibleProvider } from "@minutesbot/summary-engine";
import { attendeeWebhookUrl, defaultSettings } from "@minutesbot/shared";
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

const sendTestSummaryEmailSchema = z.object({
  to: z.string().trim().email().transform((value) => value.toLowerCase())
});

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
      webhookUrl: attendeeWebhookUrl(c.env)
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
    try {
      await client.checkHealth();
      await client.getBot("minutesbot-preflight");
    } catch (error) {
      if (!(error instanceof AttendeeClientError && error.code === "ATTENDEE_NOT_FOUND")) {
        return c.json({ ok: false, message: attendeeTestErrorMessage(error) }, 502);
      }
    }
    return c.json({
      ok: true,
      message: "Attendee API connection succeeded",
      attendee: { baseUrl: settings.attendee.baseUrl }
    });
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
  .post("/send-test-summary-email", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = sendTestSummaryEmailSchema.safeParse(body);
    if (!parsed.success) return c.json({ ok: false, message: "Enter a valid recipient email address" }, 400);

    const settings = await readSettings(c.env);
    const email = renderSummaryEmail({
      subject: "Sample recap email",
      date: "2026-05-07T14:00:00.000Z",
      summary: {
        meetingType: "general",
        recapDepth: "standard",
        summary: ["Sample recap rendered for outbound email testing."],
        decisions: ["Use the saved outbound email provider for recap delivery tests."],
        actionItems: [{ owner: "Meeting owner", task: "Review the sample recap email layout.", dueDate: "Before the next Teams meeting" }],
        openQuestions: ["Does the message arrive in the expected inbox?"],
        risks: ["Email provider configuration may still need DNS or secret updates."],
        followUps: ["Confirm SPF, DKIM, and routing if delivery is delayed."],
        meetingNotes: [
          {
            heading: "Email Delivery Validation",
            overview: "This sample recap verifies that minutesbot can render and deliver the current Teams-style recap email template.",
            items: [
              {
                title: "Provider configuration",
                detail: "The test uses the saved email provider and sender address from Setup so delivery matches production recap behavior."
              },
              {
                title: "Recipient override",
                detail: "The recipient is supplied by the admin for this test only and does not change real meeting summary eligibility."
              }
            ]
          }
        ],
        followUpTasks: [
          {
            title: "Confirm sample email delivery",
            description: "Open the target inbox and confirm the sample recap email arrived with the expected formatting.",
            owners: ["Admin"],
            dueDate: "Today"
          }
        ]
      },
      excludedRecipients: ["external.attendee@example.com"],
      recap: {
        subjectPrefix: settings.recap.subjectPrefix,
        introText: settings.recap.introText,
        sections: settings.recap.sections
      }
    });
    const provider = createEmailProvider({
      provider: settings.email.provider,
      sendEmailBinding: c.env.SEND_EMAIL,
      smtpPassword: c.env.SMTP_PASSWORD
    });

    try {
      const result = await provider.send({ from: settings.email.senderEmail, to: parsed.data.to, ...email });
      if (result.status === "failed") {
        return c.json({ ok: false, message: result.failureReason ?? "Sample recap email failed to send" }, 502);
      }
      return c.json({
        ok: true,
        message: "Sample recap email sent",
        recipient: parsed.data.to,
        status: result.status,
        providerMessageId: result.providerMessageId
      });
    } catch (error) {
      return c.json({ ok: false, message: error instanceof Error ? error.message : "Sample recap email failed to send" }, 502);
    }
  })
  .post("/verify-webhook-signature-sample", async (c) =>
    c.json({ ok: true, message: "Use ATTENDEE_WEBHOOK_SECRET and X-Webhook-Signature against /api/webhooks/attendee for live verification" })
  );

function attendeeTestErrorMessage(error: unknown): string {
  if (error instanceof AttendeeClientError) return `${error.code}: ${error.message}`;
  return `ATTENDEE_REQUEST_FAILED: ${error instanceof Error ? error.message : String(error)}`;
}
