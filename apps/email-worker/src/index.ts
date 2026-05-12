import { createArtifact, createAuditLog, getSettings, replaceMeetingAttendees, upsertMeeting } from "@minutesbot/db";
import { parseIncomingInvite } from "@minutesbot/invite-parser";
import { buildSummaryRecipients, getEmailDomain, isAllowedDomain } from "@minutesbot/recipient-policy";
import { createId, type MeetingStatus } from "@minutesbot/shared";

type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  INVITE_QUEUE: { send(message: unknown): Promise<void> };
  ENVIRONMENT?: string;
};

type EmailMessage = {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
};

export default {
  async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const rawEmail = await readTextWithLimit(message.raw, 5 * 1024 * 1024);
    ctx.waitUntil(handleInvite(message, env, rawEmail));
  }
};

export async function handleInvite(message: Pick<EmailMessage, "from" | "to" | "setReject">, env: Env, rawEmail: string): Promise<void> {
  const settings = await getSettings(env.DB);

  let parsed: ReturnType<typeof parseIncomingInvite>;
  try {
    parsed = parseIncomingInvite(rawEmail);
  } catch (error) {
    await ignoreInvite(env, message, "REJECTED_PARSE_ERROR", error instanceof Error ? error.message : "Parse error");
    return;
  }

  if (!isAuthenticatedInvite(rawEmail, parsed.rawSender, parsed.organizer.email, env.ENVIRONMENT)) {
    await rejectInvite(env, message, "REJECTED_UNAUTHENTICATED_SENDER", "Inbound sender authentication did not pass or does not align with the organizer");
    return;
  }

  if (!isRecorderRecipient(message.to, settings.recorderEmail, settings.recorderAliasEmails)) {
    await rejectInvite(env, message, "REJECTED_INVALID_RECIPIENT", "Inbound recipient does not match configured recorder email");
    return;
  }

  if (!parsed.teamsJoinUrl) {
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

  const rawKey = `raw-invites/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
  await env.ARTIFACTS.put(rawKey, rawEmail, { httpMetadata: { contentType: "message/rfc822" } });
  await createAuditLog(env.DB, { actorEmail: message.from, eventType: "invite.received", resourceType: "raw_invite", resourceId: rawKey });

  const meeting = await upsertMeeting(env.DB, {
    calendar_uid: parsed.calendarUid,
    subject: parsed.subject,
    organizer_email: parsed.organizer.email,
    organizer_name: parsed.organizer.name,
    teams_join_url: parsed.teamsJoinUrl,
    start_time: parsed.startTime,
    end_time: parsed.endTime,
    status: parsed.kind === "cancel" ? "CANCELLED" : "SCHEDULED"
  });

  await createArtifact(env.DB, {
    meeting_id: meeting.id,
    type: "raw_invite",
    r2_key: rawKey,
    content_type: "message/rfc822",
    size_bytes: new TextEncoder().encode(rawEmail).byteLength,
    deleted_at: null
  });

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

  if (parsed.kind === "cancel") {
    await createAuditLog(env.DB, { actorEmail: parsed.organizer.email, eventType: "meeting.cancelled", resourceType: "meeting", resourceId: meeting.id });
    return;
  }

  await env.INVITE_QUEUE.send({ type: "create_bot", meetingId: meeting.id });
  await createAuditLog(env.DB, { actorEmail: parsed.organizer.email, eventType: "meeting.scheduled", resourceType: "meeting", resourceId: meeting.id });
}

function isRecorderRecipient(recipient: string, recorderEmail: string, aliases: string[] = []): boolean {
  const normalizedRecipient = recipient.trim().toLowerCase();
  return [recorderEmail, ...aliases].some((email) => email.trim().toLowerCase() === normalizedRecipient);
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

async function readTextWithLimit(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) throw new Error("Inbound email exceeds the maximum supported size.");
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isAuthenticatedInvite(rawEmail: string, senderEmail: string, organizerEmail: string, environment?: string): boolean {
  if (environment !== "production") return true;
  const senderDomain = getEmailDomain(senderEmail);
  const organizerDomain = getEmailDomain(organizerEmail);
  if (!senderDomain || !organizerDomain || senderDomain !== organizerDomain) return false;
  return authenticatedDomains(rawEmail).has(senderDomain);
}

function authenticatedDomains(rawEmail: string): Set<string> {
  const headers = rawEmail.split(/\r?\n\r?\n/, 1)[0]?.replace(/\r?\n[ \t]+/g, " ") ?? "";
  const domains = new Set<string>();
  for (const line of headers.split(/\r?\n/)) {
    if (!line.toLowerCase().startsWith("authentication-results:")) continue;
    collectAuthDomain(line, /\bdmarc=pass\b[^;]*\bheader\.from=([a-z0-9.-]+)/gi, domains);
    collectAuthDomain(line, /\bdkim=pass\b[^;]*\bheader\.d=([a-z0-9.-]+)/gi, domains);
    collectAuthDomain(line, /\bspf=pass\b[^;]*\bsmtp\.mailfrom=([a-z0-9.-]+)/gi, domains);
  }
  return domains;
}

function collectAuthDomain(line: string, pattern: RegExp, domains: Set<string>): void {
  for (const match of line.matchAll(pattern)) {
    const domain = match[1]?.toLowerCase().replace(/\.+$/, "");
    if (domain) domains.add(domain);
  }
}
