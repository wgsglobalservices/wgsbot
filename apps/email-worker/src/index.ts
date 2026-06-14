import {
  createAuditLog,
  createInboundMessage,
  getSettings,
  resolveInboundMessage,
  upsertArtifact,
  type InboundMessageRow
} from "@minutesbot/db";
import { parseIncomingInvite, type ParsedMeetingInvite } from "@minutesbot/invite-parser";
import { getEmailDomain, isAllowedDomain } from "@minutesbot/recipient-policy";
import { ingestParsedInvite } from "@minutesbot/scheduler";
import { AppError, nowIso, rawInviteKey, readStreamTextWithLimit, sha256Hex, type AppSettings } from "@minutesbot/shared";
import { verifySenderAuthentication } from "./senderAuthentication";

type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  JOBS_QUEUE: { send(message: unknown, options?: { delaySeconds?: number }): Promise<void> };
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
    ctx.waitUntil(handleInbound(message, env, rawEmail));
  }
};

type RejectionReason =
  | "REJECTED_PARSE_ERROR"
  | "REJECTED_INVALID_RECIPIENT"
  | "REJECTED_UNAUTHENTICATED_SENDER"
  | "REJECTED_NO_TEAMS_LINK"
  | "REJECTED_EXTERNAL_ORGANIZER"
  | "REJECTED_NO_ELIGIBLE_RECIPIENTS";

export async function handleInbound(message: Pick<EmailMessage, "from" | "to" | "setReject">, env: Env, rawEmail: string): Promise<void> {
  const settings = await getSettings(env.DB);
  const contentHash = await sha256Hex(rawEmail);
  const headerMeta = extractHeaderMeta(rawEmail);

  // Dedup gate: forwarded copies and duplicate deliveries of the same bytes
  // are recorded once and processed once.
  const messageRow = await createInboundMessage(env.DB, {
    messageId: headerMeta.messageId,
    contentHash,
    fromEmail: message.from.toLowerCase(),
    toEmail: message.to.toLowerCase(),
    subject: headerMeta.subject,
    rawR2Key: "pending"
  });
  if (!messageRow) {
    await createAuditLog(env.DB, {
      actorEmail: message.from,
      eventType: "invite.ignored",
      resourceType: "inbound_message",
      message: "Duplicate message content; already processed",
      metadata: { contentHash, messageId: headerMeta.messageId }
    });
    return;
  }

  const rawKey = rawInviteKey(messageRow.id, nowIso());
  await env.ARTIFACTS.put(rawKey, rawEmail, { httpMetadata: { contentType: "message/rfc822" } });
  await env.DB.prepare("UPDATE inbound_messages SET raw_r2_key = ? WHERE id = ?").bind(rawKey, messageRow.id).run();
  await upsertArtifact(env.DB, {
    ownerType: "inbound_message",
    ownerId: messageRow.id,
    kind: "raw_invite",
    r2Key: rawKey,
    contentType: "message/rfc822",
    sizeBytes: new TextEncoder().encode(rawEmail).byteLength,
    sha256: contentHash
  });
  await createAuditLog(env.DB, {
    actorEmail: message.from,
    eventType: "invite.received",
    resourceType: "inbound_message",
    resourceId: messageRow.id,
    metadata: { rawKey }
  });

  let parsed: ParsedMeetingInvite;
  try {
    parsed = parseIncomingInvite(rawEmail);
  } catch (error) {
    if (error instanceof AppError && error.code === "REJECTED_NO_TEAMS_LINK") {
      await rejectMessage(env, message, messageRow, "REJECTED_NO_TEAMS_LINK", error.message);
      return;
    }
    await ignoreMessage(env, message, messageRow, error instanceof Error ? error.message : "Parse error");
    return;
  }

  if (parsed.kind === "other") {
    // Attendee responses (METHOD:REPLY/COUNTER/...) must not reschedule the
    // meeting or spawn another bot.
    await ignoreMessage(env, message, messageRow, "Calendar method is not a meeting request or cancellation", parsed);
    return;
  }

  if (!isRecorderRecipient(message.to, settings.recorderEmail, settings.recorderAliasEmails)) {
    await rejectMessage(env, message, messageRow, "REJECTED_INVALID_RECIPIENT", "Inbound recipient does not match configured recorder email", parsed);
    return;
  }

  if (settings.policy.requireAuthenticatedSender) {
    const senderAuth = verifySenderAuthentication(rawEmail, message.from);
    if (!senderAuth.allowed) {
      await rejectMessage(env, message, messageRow, "REJECTED_UNAUTHENTICATED_SENDER", senderAuth.reason, parsed);
      return;
    }
  }

  if (parsed.kind === "request" && !parsed.teamsJoinUrl) {
    await rejectMessage(env, message, messageRow, "REJECTED_NO_TEAMS_LINK", "No Teams join URL found", parsed);
    return;
  }

  const organizerDomain = getEmailDomain(parsed.organizer.email);
  if (
    parsed.kind === "request" &&
    settings.policy.rejectExternalOrganizers &&
    (!organizerDomain || !isAllowedDomain(organizerDomain, settings.allowedDomains, settings.policy.allowSubdomains))
  ) {
    await rejectMessage(env, message, messageRow, "REJECTED_EXTERNAL_ORGANIZER", "Organizer domain is not allowed", parsed);
    return;
  }

  if (parsed.kind === "request" && settings.policy.requireAtLeastOneEligibleRecipient && !hasEligibleRecipient(parsed, settings)) {
    await rejectMessage(env, message, messageRow, "REJECTED_NO_ELIGIBLE_RECIPIENTS", "No eligible same-company recap recipients", parsed);
    return;
  }

  const outcome = await ingestParsedInvite(env.DB, parsed, settings, { inboundMessageId: messageRow.id });

  await resolveInboundMessage(env.DB, messageRow.id, {
    parseStatus: "parsed",
    icsUid: parsed.calendarUid,
    icsMethod: parsed.kind,
    icsSequence: parsed.sequence ?? null,
    recurrenceId: parsed.recurrenceId?.utc ?? null,
    eventId: outcome.eventId
  });

  for (const warning of outcome.warnings) {
    await createAuditLog(env.DB, {
      eventType: "invite.received",
      severity: "warning",
      resourceType: "inbound_message",
      resourceId: messageRow.id,
      message: warning
    });
  }

  // Cancelled occurrences with live bots need their runtime sessions stopped.
  for (const occurrence of outcome.botsToCancel) {
    await env.JOBS_QUEUE.send({ type: "enqueue_cancel_bot", occurrenceId: occurrence.id });
  }

  // Wake the job runner for anything due now (e.g. a meeting already starting)
  // instead of waiting for the next cron sweep.
  if (outcome.jobsCreated > 0) {
    await env.JOBS_QUEUE.send({ type: "sweep_due_jobs" });
  }
}

function hasEligibleRecipient(parsed: ParsedMeetingInvite, settings: AppSettings): boolean {
  const candidates = [parsed.organizer.email, ...parsed.attendees.map((attendee) => attendee.email)];
  return candidates.some((email) => {
    const domain = getEmailDomain(email);
    return domain !== null && isAllowedDomain(domain, settings.allowedDomains, settings.policy.allowSubdomains);
  });
}

function extractHeaderMeta(rawEmail: string): { messageId: string | null; subject: string | null } {
  const headerText = rawEmail.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const messageIdMatch = unfolded.match(/^message-id:\s*<?([^>\s]+)>?/im);
  const subjectMatch = unfolded.match(/^subject:\s*(.+)$/im);
  return {
    messageId: messageIdMatch ? messageIdMatch[1].trim() : null,
    subject: subjectMatch ? subjectMatch[1].trim().slice(0, 500) : null
  };
}

function isRecorderRecipient(recipient: string, recorderEmail: string, aliases: string[] = []): boolean {
  const normalizedRecipient = recipient.trim().toLowerCase();
  return [recorderEmail, ...aliases].some((email) => email.trim().toLowerCase() === normalizedRecipient);
}

async function rejectMessage(
  env: Env,
  message: Pick<EmailMessage, "from" | "setReject">,
  messageRow: InboundMessageRow,
  reason: RejectionReason,
  detail: string,
  parsed?: ParsedMeetingInvite
): Promise<void> {
  message.setReject(detail);
  await resolveInboundMessage(env.DB, messageRow.id, {
    parseStatus: "rejected",
    rejectionReason: `${reason}: ${detail}`,
    icsUid: parsed?.calendarUid ?? null,
    icsMethod: parsed?.kind ?? null,
    icsSequence: parsed?.sequence ?? null,
    recurrenceId: parsed?.recurrenceId?.utc ?? null
  });
  await createAuditLog(env.DB, {
    actorEmail: message.from,
    eventType: "invite.rejected",
    severity: "warning",
    resourceType: "inbound_message",
    resourceId: messageRow.id,
    message: detail,
    metadata: { reason }
  });
}

async function ignoreMessage(
  env: Env,
  message: Pick<EmailMessage, "from">,
  messageRow: InboundMessageRow,
  detail: string,
  parsed?: ParsedMeetingInvite
): Promise<void> {
  await resolveInboundMessage(env.DB, messageRow.id, {
    parseStatus: "ignored",
    rejectionReason: detail,
    icsUid: parsed?.calendarUid ?? null,
    icsMethod: parsed?.kind ?? null
  });
  await createAuditLog(env.DB, {
    actorEmail: message.from,
    eventType: "invite.ignored",
    resourceType: "inbound_message",
    resourceId: messageRow.id,
    message: detail
  });
}
