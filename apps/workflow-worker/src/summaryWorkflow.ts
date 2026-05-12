import { createAuditLog, createEmailDelivery, createSummary, getMeeting, getSettings, listArtifacts, listMeetingAttendees, listTranscriptSegments, updateSummaryStatus } from "@minutesbot/db";
import { renderSummaryEmail } from "@minutesbot/email-renderer";
import { buildSummaryRecipients } from "@minutesbot/recipient-policy";
import { createOpenAiCompatibleProvider, summarizeTranscript } from "@minutesbot/summary-engine";
import { AppError, createTranscriptDownloadToken } from "@minutesbot/shared";
import { createEmailProvider, formatEmailAddress } from "@minutesbot/email-sender";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string };
const maxTranscriptTextBytes = 1_000_000;

export class SummaryWorkflow extends WorkflowEntrypoint<WorkflowEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    await generateAndSendSummary(this.env, event.payload.meetingId, step.do.bind(step));
  }
}

export async function generateAndSendSummary(
  env: WorkflowEnv,
  meetingId: string,
  runStep: <T>(name: string, callback: () => Promise<T>) => Promise<T> = (_name, callback) => callback()
): Promise<void> {
  const meeting = await getMeeting(env.DB, meetingId);
  if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
  const settings = await getSettings(env.DB);
  const artifacts = await listArtifacts(env.DB, meetingId);
  const transcriptArtifact = artifacts.find((artifact) => artifact.type === "transcript_text" && !artifact.deleted_at);
  if (!transcriptArtifact) throw new AppError("TRANSCRIPT_MISSING", "Transcript text artifact is missing", 400);
  const transcriptObject = await env.ARTIFACTS.get(transcriptArtifact.r2_key);
  if (transcriptObject && transcriptObject.size > maxTranscriptTextBytes) {
    throw new AppError("TRANSCRIPT_TOO_LARGE", "Transcript artifact is too large to summarize automatically.", 413);
  }
  const transcriptText = await transcriptObject?.text();
  if (!transcriptText) throw new AppError("TRANSCRIPT_MISSING", "Transcript artifact is empty", 400);
  if (new TextEncoder().encode(transcriptText).byteLength > maxTranscriptTextBytes) {
    throw new AppError("TRANSCRIPT_TOO_LARGE", "Transcript artifact is too large to summarize automatically.", 413);
  }

  await updateSummaryStatus(env.DB, meetingId, "generating");
  const attendees = await listMeetingAttendees(env.DB, meetingId);
  const transcriptSegments = await listTranscriptSegments(env.DB, meetingId);
  const transcriptMetrics = calculateTranscriptMetrics(transcriptText, transcriptSegments);
  const meetingDurationMinutes = calculateMeetingDurationMinutes(meeting.start_time ?? undefined, meeting.end_time ?? undefined);
  const provider = createOpenAiCompatibleProvider({
    baseUrl: settings.ai.baseUrl || "https://api.openai.com/v1",
    apiKey: env.AI_API_KEY ?? "",
    model: settings.ai.model
  });
  const summary = await runStep("generate summary", () =>
    summarizeTranscript(
      {
        meetingSubject: meeting.subject ?? "Untitled meeting",
        meetingStartTime: meeting.start_time ?? undefined,
        meetingEndTime: meeting.end_time ?? undefined,
        meetingDurationMinutes,
        transcriptDurationMinutes: transcriptMetrics.transcriptDurationMinutes,
        speakerTurnCount: transcriptMetrics.speakerTurnCount,
        wordCount: transcriptMetrics.wordCount,
        organizerEmail: meeting.organizer_email ?? undefined,
        attendees: attendees.map((attendee) => ({ email: attendee.email, name: attendee.name ?? undefined })),
        transcriptText,
        prompt: settings.recap.prompt,
        classificationEnabled: settings.recap.classificationEnabled,
        defaultTemplate: settings.recap.defaultTemplate,
        shortMeetingBriefRecapEnabled: settings.recap.shortMeetingBriefRecapEnabled,
        shortMeetingDurationThresholdMinutes: settings.recap.shortMeetingDurationThresholdMinutes
      },
      provider
    )
  );
  const summaryKey = `summaries/${meetingId}/summary.json`;
  await env.ARTIFACTS.put(summaryKey, JSON.stringify(summary), { httpMetadata: { contentType: "application/json" } });
  await createSummary(env.DB, { meeting_id: meetingId, r2_key: summaryKey, summary_json: JSON.stringify(summary), model: settings.ai.model });
  await updateSummaryStatus(env.DB, meetingId, "ready", "SUMMARY_READY");
  await createAuditLog(env.DB, { eventType: "summary.generated", resourceType: "meeting", resourceId: meetingId });

  const eligibleInvitees = attendees.filter((attendee) => attendee.summary_eligible);
  const ineligibleInviteeEmails = attendees.filter((attendee) => !attendee.summary_eligible).map((attendee) => attendee.email);
  const filtered = buildSummaryRecipients({
    organizer: meeting.organizer_email ? { email: meeting.organizer_email, name: meeting.organizer_name ?? undefined } : null,
    attendees: eligibleInvitees.map((attendee) => ({ email: attendee.email, name: attendee.name ?? undefined })),
    primaryDomain: settings.primaryDomain,
    allowedDomains: settings.allowedDomains,
    allowSubdomains: settings.policy.allowSubdomains
  });
  if (filtered.included.length === 0) {
    await updateSummaryStatus(env.DB, meetingId, "failed", "FAILED");
    await createAuditLog(env.DB, { eventType: "summary.failed", resourceType: "meeting", resourceId: meetingId, metadata: { reason: "no eligible recipients" } });
    return;
  }
  const email = renderSummaryEmail({
    subject: meeting.subject ?? "Untitled meeting",
    date: meeting.start_time ?? undefined,
    summary,
    transcriptDownloadUrl: await buildTranscriptDownloadUrl(env, meetingId, settings.recap.transcriptDownloadExpirationHours),
    transcriptDownloadExpirationHours: settings.recap.transcriptDownloadExpirationHours,
    excludedRecipients: Array.from(new Set([...filtered.excluded.map((recipient) => recipient.email), ...ineligibleInviteeEmails])),
    recap: {
      subjectPrefix: settings.recap.subjectPrefix,
      introText: settings.recap.introText,
      sections: settings.recap.sections
    }
  });
  const sender = createEmailProvider({ provider: settings.email.provider, sendEmailBinding: env.SEND_EMAIL });
  let sentCount = 0;
  for (const recipient of filtered.included) {
    try {
      const result = await sender.send({ from: formatEmailAddress("WGS Notetaker", settings.email.senderEmail), to: recipient.email, ...email });
      if (result.status === "sent") sentCount += 1;
      await createEmailDelivery(env.DB, {
        meeting_id: meetingId,
        recipient_email: recipient.email,
        type: "summary",
        status: result.status,
        provider_message_id: result.providerMessageId ?? null,
        failure_reason: result.failureReason ?? null,
        sent_at: result.status === "sent" ? new Date().toISOString() : null
      });
    } catch (error) {
      await createEmailDelivery(env.DB, {
        meeting_id: meetingId,
        recipient_email: recipient.email,
        type: "summary",
        status: "failed",
        provider_message_id: null,
        failure_reason: error instanceof Error ? error.message : "Email send failed",
        sent_at: null
      });
    }
  }
  if (sentCount === 0) {
    await updateSummaryStatus(env.DB, meetingId, "failed", "FAILED");
    await createAuditLog(env.DB, { eventType: "summary.failed", resourceType: "meeting", resourceId: meetingId, metadata: { reason: "email delivery failed" } });
    return;
  }
  await updateSummaryStatus(env.DB, meetingId, "sent", "SUMMARY_SENT");
  await createAuditLog(env.DB, { eventType: "summary.sent", resourceType: "meeting", resourceId: meetingId, metadata: { recipients: sentCount } });
}

function calculateMeetingDurationMinutes(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return Math.round((endMs - startMs) / 60_000);
}

function calculateTranscriptMetrics(transcriptText: string, segments: Array<Record<string, unknown>>): { wordCount: number; speakerTurnCount: number; transcriptDurationMinutes?: number } {
  const wordCount = transcriptText.trim().split(/\s+/).filter(Boolean).length;
  const meaningfulSegments = segments.filter((segment) => typeof segment.text === "string" && segment.text.trim());
  const speakerTurnCount = meaningfulSegments.length > 0 ? meaningfulSegments.length : transcriptText.split(/\n+/).filter((line) => line.trim()).length || (transcriptText.trim() ? 1 : 0);
  const timedSegments = meaningfulSegments
    .map((segment) => ({
      timestampMs: typeof segment.timestamp_ms === "number" ? segment.timestamp_ms : undefined,
      durationMs: typeof segment.duration_ms === "number" ? segment.duration_ms : 0
    }))
    .filter((segment): segment is { timestampMs: number; durationMs: number } => segment.timestampMs !== undefined);
  if (timedSegments.length === 0) return { wordCount, speakerTurnCount };
  const first = Math.min(...timedSegments.map((segment) => segment.timestampMs));
  const last = Math.max(...timedSegments.map((segment) => segment.timestampMs + segment.durationMs));
  return { wordCount, speakerTurnCount, transcriptDurationMinutes: Math.round(((last - first) / 60_000) * 10) / 10 };
}

async function buildTranscriptDownloadUrl(env: WorkflowEnv, meetingId: string, expirationHours: number): Promise<string | undefined> {
  if (!env.TRANSCRIPT_LINK_SECRET || !env.API_BASE_URL) return undefined;
  const cappedExpirationHours = Math.min(Math.max(expirationHours, 1), 24);
  const expiresAt = Date.now() + cappedExpirationHours * 60 * 60 * 1000;
  const token = await createTranscriptDownloadToken({ meetingId, artifactType: "transcript_text", expiresAt }, env.TRANSCRIPT_LINK_SECRET);
  return `${env.API_BASE_URL.replace(/\/+$/, "")}/api/artifacts/${encodeURIComponent(meetingId)}/transcript.txt?token=${encodeURIComponent(token)}`;
}
