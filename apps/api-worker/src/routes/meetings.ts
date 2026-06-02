import { Hono } from "hono";
import { z } from "zod";
import { createAuditLog, getLatestSummary, getMeeting, listArtifacts, listEmailDeliveries, listMeetingAttendees, listMeetingsWithEligibleRecipientCounts, listTranscriptSegments, listWebhookEvents, type ArtifactRow } from "@minutesbot/db";
import type { SummaryEmailSummary } from "@minutesbot/email-renderer";
import { AppError } from "@minutesbot/shared";
import type { Env } from "../env";
import { deleteMeetingArtifacts, deleteMeetingHistory } from "../services/artifactService";
import { readSettings } from "../services/settingsService";
import { sendMeetingSummaryEmail } from "../../../workflow-worker/src/summaryEmailDelivery";

const sendSummaryEmailSchema = z.object({
  to: z.string().trim().email().transform((value) => value.toLowerCase())
});

const meetingsQuerySchema = z.object({
  futureDays: z.coerce.number().int().min(0).max(365).default(7)
});

export const meetingsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const query = meetingsQuerySchema.parse(c.req.query());
    const futureHorizonIso = new Date(Date.now() + query.futureDays * 24 * 60 * 60 * 1000).toISOString();
    return c.json({ meetings: await listMeetingsWithEligibleRecipientCounts(c.env.DB, { futureHorizonIso }) });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const meeting = await getMeeting(c.env.DB, id);
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    return c.json({
      meeting,
      attendees: await listMeetingAttendees(c.env.DB, id),
      transcriptSegments: await listTranscriptSegments(c.env.DB, id),
      artifacts: await listArtifacts(c.env.DB, id),
      webhookEvents: await listWebhookEvents(c.env.DB, id),
      emailDeliveries: await listEmailDeliveries(c.env.DB, id),
      summary: await getLatestSummary(c.env.DB, id)
    });
  })
  .get("/:id/transcript.txt", async (c) => {
    const id = c.req.param("id");
    const artifact = findLatestActiveArtifact(await listArtifacts(c.env.DB, id), "transcript_text");
    if (!artifact) throw new AppError("NOT_FOUND", "Transcript not found.", 404);
    const object = await c.env.ARTIFACTS.get(artifact.r2_key);
    const transcript = await object?.text();
    if (!transcript) throw new AppError("NOT_FOUND", "Transcript not found.", 404);
    return new Response(transcript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-disposition": `inline; filename="${safeFilename(id)}-transcript.txt"`
      }
    });
  })
  .get("/:id/recording", async (c) => {
    const id = c.req.param("id");
    const artifact = findLatestActiveArtifact(await listArtifacts(c.env.DB, id), "recording");
    if (!artifact) throw new AppError("NOT_FOUND", "Recording not found.", 404);
    const object = await c.env.ARTIFACTS.get(artifact.r2_key);
    if (!object?.body) throw new AppError("NOT_FOUND", "Recording not found.", 404);
    const contentType = playableMediaContentType(artifact, object) ?? "application/octet-stream";
    const headers = new Headers({
      "content-type": contentType,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-disposition": `inline; filename="${safeFilename(id)}-recording${recordingExtension(contentType)}"`
    });
    const size = typeof artifact.size_bytes === "number" ? artifact.size_bytes : object.size;
    if (typeof size === "number") headers.set("content-length", String(size));
    return new Response(object.body, { headers });
  })
  .post("/:id/retry-bot", async (c) => {
    const id = c.req.param("id");
    await c.env.INVITE_QUEUE.send({ type: "create_bot", meetingId: id, force: true });
    return c.json({ ok: true });
  })
  .post("/:id/retry-summary", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "summarize", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/regenerate-recap", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "summarize", meetingId: c.req.param("id"), force: true });
    return c.json({ ok: true });
  })
  .post("/:id/send-summary-email", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = sendSummaryEmailSchema.safeParse(body);
    if (!parsed.success) throw new AppError("INVALID_RECIPIENT", "Enter a valid recipient email address", 400);

    const id = c.req.param("id");
    const meeting = await getMeeting(c.env.DB, id);
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    const attendees = await listMeetingAttendees(c.env.DB, id);
    const allowedRecipients = new Set([
      ...(meeting.organizer_email ? [meeting.organizer_email] : []),
      ...attendees.map((attendee) => attendee.email)
    ].map((email) => email.trim().toLowerCase()));
    if (!allowedRecipients.has(parsed.data.to)) {
      throw new AppError("RECIPIENT_NOT_ON_MEETING", "Choose the organizer or an attendee on this meeting.", 400);
    }

    const summaryRow = await getLatestSummary(c.env.DB, id);
    if (!summaryRow) throw new AppError("SUMMARY_MISSING", "Generate a recap before sending email.", 400);
    const settings = await readSettings(c.env);
    const result = await sendMeetingSummaryEmail(c.env, {
      meeting,
      settings,
      summary: parseSavedSummary(summaryRow.summary_json),
      recipientEmail: parsed.data.to,
      excludedRecipients: attendees.filter((attendee) => !attendee.summary_eligible).map((attendee) => attendee.email)
    });
    if (result.status === "failed") {
      throw new AppError("EMAIL_SEND_FAILED", result.failureReason ?? "Meeting recap email failed to send", 502);
    }
    await createAuditLog(c.env.DB, { eventType: "email.sent", resourceType: "meeting", resourceId: id, metadata: { recipient: parsed.data.to, type: "summary" } });
    return c.json({
      ok: true,
      message: "Meeting recap email sent",
      recipient: parsed.data.to,
      status: result.status,
      providerMessageId: result.providerMessageId
    });
  })
  .post("/:id/generate-transcript", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "generate_transcript", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/fetch-transcript", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "generate_transcript", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/delete-attendee-data", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "delete_attendee_data", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const meeting = await getMeeting(c.env.DB, id);
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    const result = await deleteMeetingHistory(c.env, id);
    return c.json({ ok: true, deleted: true, ...result });
  })
  .delete("/:id/artifacts", async (c) => c.json({ ok: true, deleted: await deleteMeetingArtifacts(c.env, c.req.param("id")) }));

function parseSavedSummary(summaryJson: string): SummaryEmailSummary {
  try {
    const parsed = JSON.parse(summaryJson);
    if (parsed && typeof parsed === "object") return parsed as SummaryEmailSummary;
  } catch {
    // Fall through to the typed application error below.
  }
  throw new AppError("INVALID_SUMMARY", "The saved recap cannot be rendered for email.", 500);
}

function findLatestActiveArtifact(artifacts: ArtifactRow[], type: string): ArtifactRow | undefined {
  return artifacts
    .filter((artifact) => artifact.type === type && !artifact.deleted_at)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
}

function playableMediaContentType(artifact: ArtifactRow, object: R2ObjectBody): string | null {
  const explicitType = cleanContentType(artifact.content_type) ?? cleanContentType(object.httpMetadata?.contentType);
  if (explicitType?.startsWith("audio/") || explicitType?.startsWith("video/")) return explicitType;
  if (!explicitType || explicitType === "application/octet-stream" || explicitType === "application/json") return inferRecordingContentType(artifact.r2_key) ?? explicitType ?? null;
  return explicitType;
}

function cleanContentType(value?: string | null): string | null {
  const type = value?.split(";")[0]?.trim().toLowerCase();
  return type || null;
}

function inferRecordingContentType(key: string): string | null {
  const normalized = key.toLowerCase();
  if (normalized.endsWith(".mp3")) return "audio/mpeg";
  if (normalized.endsWith(".m4a")) return "audio/mp4";
  if (normalized.endsWith(".wav")) return "audio/wav";
  if (normalized.endsWith(".webm")) return "audio/webm";
  if (normalized.endsWith(".mp4")) return "video/mp4";
  return null;
}

function recordingExtension(contentType: string): string {
  if (contentType === "audio/mpeg") return ".mp3";
  if (contentType === "audio/mp4") return ".m4a";
  if (contentType === "audio/wav") return ".wav";
  if (contentType === "audio/webm") return ".webm";
  if (contentType === "video/mp4") return ".mp4";
  return "";
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "meeting";
}
