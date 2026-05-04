import { createAuditLog, createSummary, getMeeting, getSettings, listArtifacts, listMeetingAttendees, updateSummaryStatus } from "@minutesbot/db";
import { renderSummaryEmail } from "@minutesbot/email-renderer";
import { filterSummaryRecipients } from "@minutesbot/recipient-policy";
import { createOpenAiCompatibleProvider, summarizeTranscript } from "@minutesbot/summary-engine";
import { AppError } from "@minutesbot/shared";
import { createEmailProvider } from "@minutesbot/email-sender";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string };

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
  const transcriptText = await transcriptObject?.text();
  if (!transcriptText) throw new AppError("TRANSCRIPT_MISSING", "Transcript artifact is empty", 400);

  await updateSummaryStatus(env.DB, meetingId, "generating");
  const attendees = await listMeetingAttendees(env.DB, meetingId);
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
        organizerEmail: meeting.organizer_email ?? undefined,
        attendees: attendees.map((attendee) => ({ email: attendee.email, name: attendee.name ?? undefined })),
        transcriptText
      },
      provider
    )
  );
  const summaryKey = `summaries/${meetingId}/summary.json`;
  await env.ARTIFACTS.put(summaryKey, JSON.stringify(summary), { httpMetadata: { contentType: "application/json" } });
  await createSummary(env.DB, { meeting_id: meetingId, r2_key: summaryKey, summary_json: JSON.stringify(summary), model: settings.ai.model });
  await updateSummaryStatus(env.DB, meetingId, "ready", "SUMMARY_READY");
  await createAuditLog(env.DB, { eventType: "summary.generated", resourceType: "meeting", resourceId: meetingId });

  const filtered = filterSummaryRecipients(attendees.map((attendee) => ({ email: attendee.email, name: attendee.name ?? undefined })), {
    allowedDomains: settings.allowedDomains,
    allowSubdomains: settings.policy.allowSubdomains,
    sendToExternalAttendees: false
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
    excludedRecipients: filtered.excluded.map((recipient) => recipient.email)
  });
  const sender = createEmailProvider({ provider: settings.email.provider, sendEmailBinding: env.SEND_EMAIL });
  for (const recipient of filtered.included) {
    await sender.send({ from: settings.email.senderEmail, to: recipient.email, ...email });
  }
  await updateSummaryStatus(env.DB, meetingId, "sent", "SUMMARY_SENT");
  await createAuditLog(env.DB, { eventType: "summary.sent", resourceType: "meeting", resourceId: meetingId, metadata: { recipients: filtered.included.length } });
}
