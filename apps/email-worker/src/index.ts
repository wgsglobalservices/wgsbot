import { createArtifact, createAuditLog, getSettings, replaceMeetingAttendees, upsertMeeting, type MeetingRow } from "@minutesbot/db";
import { parseIncomingInvite } from "@minutesbot/invite-parser";
import { buildSummaryRecipients, getEmailDomain, isAllowedDomain } from "@minutesbot/recipient-policy";
import { createId, readStreamTextWithLimit, type MeetingStatus } from "@minutesbot/shared";
import { verifySenderAuthentication } from "./senderAuthentication";

type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  INVITE_QUEUE: { send(message: unknown): Promise<void> };
};

type EmailMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
};

const MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024;

export default {
  async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const rawEmail = await readStreamTextWithLimit(message.raw, MAX_RAW_EMAIL_BYTES, "RAW_INVITE_TOO_LARGE");
    ctx.waitUntil(handleInvite(message, env, rawEmail));
  }
};

export async function handleInvite(message: Pick<EmailMessage, "from" | "to" | "setReject">, env: Env, rawEmail: string): Promise<void> {
  const settings = await getSettings(env.DB);
  const rawKey = `raw-invites/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
  await env.ARTIFACTS.put(rawKey, rawEmail, { httpMetadata: { contentType: "message/rfc822" } });
  await createAuditLog(env.DB, { actorEmail: message.from, eventType: "invite.received", resourceType: "raw_invite", resourceId: rawKey });

  let parsed: ReturnType<typeof parseIncomingInvite>;
  try {
    parsed = parseIncomingInvite(rawEmail);
  } catch (error) {
    await ignoreInvite(env, message, "REJECTED_PARSE_ERROR", error instanceof Error ? error.message : "Parse error");
    return;
  }

  if (parsed.kind === "other") {
    // Attendee responses (METHOD:REPLY/COUNTER/...) must not reschedule the
    // meeting or spawn another bot.
    await ignoreInvite(env, message, "REJECTED_PARSE_ERROR", "Calendar method is not a meeting request or cancellation");
    return;
  }

  if (!isRecorderRecipient(message.to, settings.recorderEmail, settings.recorderAliasEmails)) {
    await rejectInvite(env, message, "REJECTED_INVALID_RECIPIENT", "Inbound recipient does not match configured recorder email");
    return;
  }

  if (settings.policy.requireAuthenticatedSender) {
    const senderAuth = verifySenderAuthentication(rawEmail, message.from);
    if (!senderAuth.allowed) {
      await rejectInvite(env, message, "REJECTED_UNAUTHENTICATED_SENDER", senderAuth.reason);
      return;
    }
  }

  if (parsed.kind === "request" && !parsed.teamsJoinUrl) {
    await rejectInvite(env, message, "REJECTED_NO_TEAMS_LINK", "No Teams join URL found");
    return;
  }

  const organizerDomain = getEmailDomain(parsed.organizer.email);
  if (
    settings.policy.rejectExternalOrganizers &&
    (!organizerDomain || !isAllowedDomain(organizerDomain, [settings.primaryDomain, ...settings.allowedDomains], settings.policy.allowSubdomains))
  ) {
    await rejectInvite(env, message, "REJECTED_EXTERNAL_ORGANIZER", "Organizer domain is not allowed");
    return;
  }

  if (parsed.kind === "cancel") {
    await handleCancellation(env, parsed, rawEmail, rawKey);
    return;
  }

  const meetingInvitees = parsed.attendees.filter((attendee) => !isRecorderRecipient(attendee.email, settings.recorderEmail, settings.recorderAliasEmails));
  const filtered = buildSummaryRecipients({
    organizer: parsed.organizer,
    attendees: meetingInvitees,
    primaryDomain: settings.primaryDomain,
    allowedDomains: settings.allowedDomains,
    allowSubdomains: settings.policy.allowSubdomains
  });

  if (settings.policy.requireAtLeastOneEligibleRecipient && filtered.included.length === 0) {
    await rejectInvite(env, message, "REJECTED_NO_ELIGIBLE_RECIPIENTS", "No eligible same-company summary recipients");
    return;
  }

  const meeting = await upsertMeeting(env.DB, {
    calendar_uid: parsed.calendarUid,
    subject: parsed.subject,
    organizer_email: parsed.organizer.email,
    organizer_name: parsed.organizer.name,
    teams_join_url: parsed.teamsJoinUrl ?? undefined,
    start_time: parsed.startTime,
    end_time: parsed.endTime,
    status: "SCHEDULED"
  });

  await recordRawInviteArtifact(env, meeting.id, rawKey, rawEmail);

  await replaceMeetingAttendees(
    env.DB,
    meeting.id,
    [
      ...filtered.included.map((recipient) => ({
        email: recipient.email,
        name: recipient.name ?? null,
        role: null,
        domain: recipient.domain ?? null,
        summary_eligible: 1,
        exclusion_reason: null
      })),
      ...filtered.excluded.map((recipient) => ({
        email: recipient.email,
        name: recipient.name ?? null,
        role: null,
        domain: recipient.domain ?? null,
        summary_eligible: 0,
        exclusion_reason: recipient.reason
      }))
    ]
  );

  await env.INVITE_QUEUE.send({ type: "create_bot", meetingId: meeting.id });
  await createAuditLog(env.DB, { actorEmail: parsed.organizer.email, eventType: "meeting.scheduled", resourceType: "meeting", resourceId: meeting.id });
}

async function handleCancellation(env: Env, parsed: ReturnType<typeof parseIncomingInvite>, rawEmail: string, rawKey: string): Promise<void> {
  // Cancellations are matched by calendar UID. Fields missing from the
  // CANCEL payload (subject, times, join URL) keep their stored values, and
  // the attendee list is preserved as meeting history.
  const meeting: MeetingRow = await upsertMeeting(env.DB, {
    calendar_uid: parsed.calendarUid,
    subject: parsed.subject || undefined,
    organizer_email: parsed.organizer.email || undefined,
    organizer_name: parsed.organizer.name,
    teams_join_url: parsed.teamsJoinUrl ?? undefined,
    start_time: parsed.startTime || undefined,
    end_time: parsed.endTime || undefined,
    status: "CANCELLED"
  });

  await recordRawInviteArtifact(env, meeting.id, rawKey, rawEmail);

  if (meeting.attendee_bot_id && shouldCancelBot(meeting.attendee_bot_state, meeting.status)) {
    await env.INVITE_QUEUE.send({
      type: "cancel_bot",
      meetingId: meeting.id,
      botId: meeting.attendee_bot_id,
      reason: "calendar_cancel"
    });
  }
  await createAuditLog(env.DB, { actorEmail: parsed.organizer.email, eventType: "meeting.cancelled", resourceType: "meeting", resourceId: meeting.id });
}

async function recordRawInviteArtifact(env: Env, meetingId: string, rawKey: string, rawEmail: string): Promise<void> {
  await createArtifact(env.DB, {
    meeting_id: meetingId,
    type: "raw_invite",
    r2_key: rawKey,
    content_type: "message/rfc822",
    size_bytes: new TextEncoder().encode(rawEmail).byteLength,
    deleted_at: null
  });
}

function isRecorderRecipient(recipient: string, recorderEmail: string, aliases: string[] = []): boolean {
  const normalizedRecipient = recipient.trim().toLowerCase();
  return [recorderEmail, ...aliases].some((email) => email.trim().toLowerCase() === normalizedRecipient);
}

function shouldCancelBot(botState: string | null | undefined, status: MeetingStatus): boolean {
  if (["BOT_ENDED", "SUMMARY_SENT", "FAILED", "BOT_FATAL_ERROR"].includes(status)) return false;
  return !botState || !["ended", "failed", "cancelled"].includes(botState);
}

async function rejectInvite(env: Env, message: Pick<EmailMessage, "from" | "setReject">, status: MeetingStatus, reason: string): Promise<void> {
  message.setReject(reason);
  await recordRejectedInvite(env, message.from, status, reason);
}

async function ignoreInvite(env: Env, message: Pick<EmailMessage, "from">, status: MeetingStatus, reason: string): Promise<void> {
  await createAuditLog(env.DB, {
    actorEmail: message.from,
    eventType: "invite.ignored",
    resourceType: "invite",
    resourceId: createId("ign"),
    metadata: { status: "IGNORED_NON_CALENDAR_EMAIL", originalStatus: status, reason }
  });
}

async function recordRejectedInvite(env: Env, actorEmail: string, status: MeetingStatus, reason: string): Promise<void> {
  await createAuditLog(env.DB, {
    actorEmail,
    eventType: "invite.rejected",
    resourceType: "invite",
    resourceId: createId("rej"),
    metadata: { status, reason }
  });
}
