import { Hono } from "hono";
import { z } from "zod";
import { createAuditLog, upsertArtifact, upsertMeeting } from "@minutesbot/db";
import { AttendeeClient, AttendeeClientError } from "@minutesbot/attendee-client";
import { parseIncomingInvite } from "@minutesbot/invite-parser";
import { renderSummaryEmail } from "@minutesbot/email-renderer";
import { createEmailProvider, formatEmailAddress } from "@minutesbot/email-sender";
import { createOpenAiCompatibleProvider } from "@minutesbot/summary-engine";
import { attendeeWebhookUrl, defaultSettings } from "@minutesbot/shared";
import type { Env } from "../env";
import { readSettings } from "../services/settingsService";
import { maxTranscriptTextBytes } from "../../../workflow-worker/src/summaryWorkflow";

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

const uploadedTranscriptRecapSchema = z.object({
  recipient: z.string().trim().email().transform((value) => value.toLowerCase()),
  subject: z.string().trim().min(1),
  meetingStartTime: z.string().trim().refine((value) => Number.isFinite(Date.parse(value))),
  organizerEmail: z.string().trim().email().transform((value) => value.toLowerCase()),
  organizerName: z.string().trim().optional(),
  transcriptText: z.string()
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
  .post("/test-openrouter", async (c) => {
    const settings = await readSettings(c.env);
    if (!c.env.AI_API_KEY) return c.json({ ok: false, message: "AI_API_KEY secret is not configured" }, 400);

    const baseUrl = openRouterBaseUrl(settings.ai.baseUrl);
    const headers = { authorization: `Bearer ${c.env.AI_API_KEY}` };
    try {
      const keyResponse = await fetch(`${baseUrl}/key`, { headers });
      if (!keyResponse.ok) {
        return c.json({ ok: false, message: await providerFailureMessage("OpenRouter key check", keyResponse, c.env.AI_API_KEY) }, 502);
      }
      const keyPayload = (await keyResponse.json()) as { data?: { label?: unknown; limit_remaining?: unknown } };

      const modelsResponse = await fetch(`${baseUrl}/models?output_modalities=transcription`, { headers });
      if (!modelsResponse.ok) {
        return c.json({ ok: false, message: await providerFailureMessage("OpenRouter model check", modelsResponse, c.env.AI_API_KEY) }, 502);
      }
      const modelsPayload = (await modelsResponse.json()) as { data?: Array<{ id?: unknown }> };
      const modelIds = new Set((modelsPayload.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === "string"));
      if (!modelIds.has(settings.recap.transcriptionModel)) {
        return c.json({ ok: false, message: `OpenRouter transcription model is unavailable: ${settings.recap.transcriptionModel}` }, 502);
      }

      return c.json({
        ok: true,
        message: "OpenRouter connection succeeded",
        provider: {
          baseUrl,
          transcriptionModel: settings.recap.transcriptionModel,
          keyLabel: typeof keyPayload.data?.label === "string" ? keyPayload.data.label : undefined,
          limitRemaining: typeof keyPayload.data?.limit_remaining === "number" ? keyPayload.data.limit_remaining : undefined
        }
      });
    } catch (error) {
      return c.json({ ok: false, message: error instanceof Error ? error.message : "OpenRouter connection failed" }, 502);
    }
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
      const result = await provider.send({ from: formatEmailAddress("WGS Notetaker", settings.email.senderEmail), to: parsed.data.to, ...email });
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
  .post("/test-uploaded-transcript-recap", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = uploadedTranscriptRecapSchema.safeParse(body);
    if (!parsed.success) {
      const recipientIssue = parsed.error.issues.some((issue) => issue.path[0] === "recipient");
      return c.json({ ok: false, message: recipientIssue ? "Enter a valid recipient email address" : "Enter valid recap test details" }, 400);
    }
    const transcriptText = parsed.data.transcriptText.trim();
    if (!transcriptText) return c.json({ ok: false, message: "Upload or paste a transcript to test recap generation" }, 400);
    if (new TextEncoder().encode(transcriptText).byteLength > maxTranscriptTextBytes) {
      return c.json({ ok: false, message: "Transcript is too large to summarize automatically" }, 413);
    }
    if (!c.env.AI_API_KEY) return c.json({ ok: false, message: "AI_API_KEY secret is not configured" }, 400);

    const meeting = await upsertMeeting(c.env.DB, {
      calendar_uid: `test-recap-upload:${crypto.randomUUID()}`,
      subject: parsed.data.subject,
      organizer_email: parsed.data.organizerEmail,
      organizer_name: parsed.data.organizerName || null,
      teams_join_url: null,
      start_time: new Date(parsed.data.meetingStartTime).toISOString(),
      end_time: null,
      status: "TRANSCRIPT_AVAILABLE",
      transcript_status: "complete",
      summary_status: "queued"
    });
    const transcriptKey = `transcripts/${meeting.id}/transcript.txt`;
    const transcriptJsonKey = `transcripts/${meeting.id}/transcript.json`;
    const transcriptJson = JSON.stringify({ source: "admin-upload", text: transcriptText });
    await c.env.ARTIFACTS.put(transcriptKey, transcriptText, { httpMetadata: { contentType: "text/plain; charset=UTF-8" } });
    await c.env.ARTIFACTS.put(transcriptJsonKey, transcriptJson, { httpMetadata: { contentType: "application/json" } });
    await upsertArtifact(c.env.DB, {
      meeting_id: meeting.id,
      type: "transcript_text",
      r2_key: transcriptKey,
      content_type: "text/plain",
      size_bytes: new TextEncoder().encode(transcriptText).byteLength,
      deleted_at: null
    });
    await upsertArtifact(c.env.DB, {
      meeting_id: meeting.id,
      type: "transcript_json",
      r2_key: transcriptJsonKey,
      content_type: "application/json",
      size_bytes: new TextEncoder().encode(transcriptJson).byteLength,
      deleted_at: null
    });
    await createAuditLog(c.env.DB, { eventType: "transcript.fetched", resourceType: "meeting", resourceId: meeting.id, metadata: { source: "admin-upload" } });

    try {
      await c.env.SUMMARY_QUEUE.send({
        type: "send_uploaded_transcript_recap",
        meetingId: meeting.id,
        recipientEmail: parsed.data.recipient
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          message: "Could not queue uploaded transcript recap email",
          detail: error instanceof Error ? error.message : "Queue send failed",
          meetingId: meeting.id
        },
        502
      );
    }
    return c.json({
      ok: true,
      message: "Uploaded transcript recap queued",
      meetingId: meeting.id,
      recipient: parsed.data.recipient,
      status: "queued"
    });
  })
  .post("/verify-webhook-signature-sample", async (c) =>
    c.json({ ok: true, message: "Use ATTENDEE_WEBHOOK_SECRET and X-Webhook-Signature against /api/webhooks/attendee for live verification" })
  );

function attendeeTestErrorMessage(error: unknown): string {
  if (error instanceof AttendeeClientError) return `${error.code}: ${error.message}`;
  return `ATTENDEE_REQUEST_FAILED: ${error instanceof Error ? error.message : String(error)}`;
}

function openRouterBaseUrl(configuredBaseUrl?: string): string {
  try {
    const configured = configuredBaseUrl ? new URL(configuredBaseUrl) : null;
    return configured?.hostname === "openrouter.ai" ? configured.toString().replace(/\/+$/, "") : "https://openrouter.ai/api/v1";
  } catch {
    return "https://openrouter.ai/api/v1";
  }
}

async function providerFailureMessage(label: string, response: Response, secret: string): Promise<string> {
  const detail = await response
    .clone()
    .json()
    .then((payload) => providerPayloadMessage(payload))
    .catch(async () => providerPayloadMessage(await response.text().catch(() => "")));
  const suffix = detail ? `: ${redactSecret(detail, secret)}` : "";
  return `${label} failed with ${response.status}${suffix}`;
}

function providerPayloadMessage(payload: unknown): string {
  if (typeof payload === "string") return payload.trim().slice(0, 300);
  if (payload && typeof payload === "object") {
    const record = payload as { error?: { message?: unknown }; message?: unknown };
    if (typeof record.error?.message === "string") return record.error.message.slice(0, 300);
    if (typeof record.message === "string") return record.message.slice(0, 300);
  }
  return "";
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join("[redacted]") : value;
}
