import { createEmailDelivery } from "@minutesbot/db";
import { renderSummaryEmail } from "@minutesbot/email-renderer";
import type { SummaryEmailSummary } from "@minutesbot/email-renderer";
import { createEmailProvider, formatEmailAddress } from "@minutesbot/email-sender";
import type { AppSettings } from "@minutesbot/shared";
import type { EmailSendResult } from "@minutesbot/email-sender";
import type { MeetingRow } from "@minutesbot/db";

type SummaryEmailEnv = {
  DB: D1Database;
  SEND_EMAIL?: { send: (message: unknown) => Promise<unknown> };
};

export async function sendMeetingSummaryEmail(
  env: SummaryEmailEnv,
  input: {
    meeting: Pick<MeetingRow, "id" | "subject" | "start_time">;
    settings: Pick<AppSettings, "email" | "recap">;
    summary: SummaryEmailSummary;
    recipientEmail: string;
    excludedRecipients?: string[];
  }
): Promise<EmailSendResult> {
  const email = renderSummaryEmail({
    subject: input.meeting.subject ?? "Untitled meeting",
    date: input.meeting.start_time ?? undefined,
    summary: input.summary,
    excludedRecipients: input.excludedRecipients,
    recap: {
      subjectPrefix: input.settings.recap.subjectPrefix,
      introText: input.settings.recap.introText,
      sections: input.settings.recap.sections
    }
  });
  const provider = createEmailProvider({ provider: input.settings.email.provider, sendEmailBinding: env.SEND_EMAIL });

  try {
    const result = await provider.send({
      from: formatEmailAddress("WGS Notetaker", input.settings.email.senderEmail),
      to: input.recipientEmail,
      ...email
    });
    await createEmailDelivery(env.DB, {
      meeting_id: input.meeting.id,
      recipient_email: input.recipientEmail,
      type: "summary",
      status: result.status,
      provider_message_id: result.providerMessageId ?? null,
      failure_reason: result.failureReason ?? null,
      sent_at: result.status === "sent" ? new Date().toISOString() : null
    });
    return result;
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "Email send failed";
    await createEmailDelivery(env.DB, {
      meeting_id: input.meeting.id,
      recipient_email: input.recipientEmail,
      type: "summary",
      status: "failed",
      provider_message_id: null,
      failure_reason: failureReason,
      sent_at: null
    });
    return { status: "failed", failureReason };
  }
}
