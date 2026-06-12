import {
  cancelFutureSeriesOccurrences,
  cancelMeetingSeries,
  createArtifact,
  createAuditLog,
  getSettings,
  markStaleRecurringOccurrencesCancelled,
  replaceMeetingAttendees,
  updateMeetingStatus,
  upsertMeeting,
  upsertMeetingSeries
} from "@minutesbot/db";
import { expandInviteOccurrences, parseIncomingInvite } from "@minutesbot/invite-parser";
import { buildSummaryRecipients, getEmailDomain, isAllowedDomain } from "@minutesbot/recipient-policy";
import { createId, shouldCreateBotNow, weeklySalesRecapEmail, type MeetingStatus } from "@minutesbot/shared";

type MeetingType = "weekly_sales" | "general";

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

  const salesRecapSourceRecipient = findSalesRecapSourceRecipient(message.to, rawEmail);
  const recorderAliasEmails = [...settings.recorderAliasEmails, weeklySalesRecapEmail];
  if (!isRecorderRecipient(message.to, settings.recorderEmail, recorderAliasEmails) && !salesRecapSourceRecipient) {
    await rejectInvite(env, message, "REJECTED_INVALID_RECIPIENT", "Inbound recipient does not match configured recorder email");
    return;
  }

  if (!parsed.teamsJoinUrl && parsed.kind !== "cancel") {
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

  const meetingType: MeetingType = salesRecapSourceRecipient ? "weekly_sales" : "general";
  const sourceRecipient = salesRecapSourceRecipient ?? normalizeEmailAddress(message.to) ?? message.to.trim().toLowerCase();
  const meetingInvitees = parsed.attendees.filter((attendee) => !isRecorderRecipient(attendee.email, settings.recorderEmail, recorderAliasEmails));
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

  const rawSizeBytes = new TextEncoder().encode(rawEmail).byteLength;
  const now = new Date().toISOString();
  const attendeeRows = [
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
  ];

  if (parsed.kind === "cancel") {
    await cancelMeetingSeries(env.DB, parsed.seriesUid, now);
    if (parsed.calendarUid === parsed.seriesUid) await cancelFutureSeriesOccurrences(env.DB, { seriesUid: parsed.seriesUid, nowIso: now });
  }

  const occurrences = parsed.kind === "cancel" ? [] : expandInviteOccurrences(parsed);
  const visibleOccurrences = occurrences.length > 0
    ? occurrences
    : [
        {
          calendarUid: parsed.calendarUid,
          seriesUid: parsed.seriesUid,
          startTime: parsed.startTime,
          endTime: parsed.endTime,
          timeZone: parsed.timeZone,
          occurrenceIndex: 0,
          recurring: Boolean(parsed.recurrence)
        }
      ];

  if (parsed.kind !== "cancel" && parsed.recurrence) {
    await upsertMeetingSeries(env.DB, {
      series_uid: parsed.seriesUid,
      subject: parsed.subject,
      organizer_email: parsed.organizer.email,
      organizer_name: parsed.organizer.name,
      teams_join_url: parsed.teamsJoinUrl,
      first_start_time: parsed.startTime,
      first_end_time: parsed.endTime,
      time_zone: parsed.timeZone,
      recurrence_json: JSON.stringify(parsed.recurrence),
      attendees_json: JSON.stringify(attendeeRows),
      meeting_type: meetingType,
      source_recipient: sourceRecipient,
      raw_invite_r2_key: rawKey,
      raw_invite_size_bytes: rawSizeBytes,
      status: "ACTIVE",
      expanded_until: maxOccurrenceStartTime(occurrences)
    });
  }

  if (parsed.kind !== "cancel" && parsed.recurrence && occurrences.length > 0) {
    await markStaleRecurringOccurrencesCancelled(env.DB, {
      seriesUid: parsed.seriesUid,
      keepCalendarUids: occurrences.map((occurrence) => occurrence.calendarUid),
      nowIso: now
    });
  }

  for (const occurrence of visibleOccurrences) {
    const meeting = await upsertMeeting(env.DB, {
      calendar_uid: occurrence.calendarUid,
      subject: parsed.subject,
      organizer_email: parsed.organizer.email,
      organizer_name: parsed.organizer.name,
      teams_join_url: parsed.teamsJoinUrl,
      start_time: occurrence.startTime,
      end_time: occurrence.endTime,
      time_zone: occurrence.timeZone ?? parsed.timeZone,
      meeting_type: meetingType,
      source_recipient: sourceRecipient,
      series_uid: occurrence.seriesUid,
      occurrence_index: occurrence.occurrenceIndex,
      recurring: occurrence.recurring ? 1 : 0,
      status: parsed.kind === "cancel" ? "CANCELLED" : "SCHEDULED"
    });

    await createArtifact(env.DB, {
      meeting_id: meeting.id,
      type: "raw_invite",
      r2_key: rawKey,
      content_type: "message/rfc822",
      size_bytes: rawSizeBytes,
      deleted_at: null
    });

    await replaceMeetingAttendees(
      env.DB,
      meeting.id,
      attendeeRows
    );

    if (parsed.kind === "cancel") {
      await createAuditLog(env.DB, { actorEmail: parsed.organizer.email, eventType: "meeting.cancelled", resourceType: "meeting", resourceId: meeting.id });
      continue;
    }

    if (shouldCreateBotNow(meeting.start_time, settings.attendee.createBotMinutesBeforeStart)) {
      await env.INVITE_QUEUE.send({ type: "create_bot", meetingId: meeting.id });
    } else {
      await updateMeetingStatus(env.DB, meeting.id, "WAITING_TO_CREATE_BOT");
    }
    await createAuditLog(env.DB, { actorEmail: parsed.organizer.email, eventType: "meeting.scheduled", resourceType: "meeting", resourceId: meeting.id });
  }
}

function maxOccurrenceStartTime(occurrences: Array<{ startTime: string }>): string | null {
  return occurrences.reduce<string | null>((latest, occurrence) => (!latest || occurrence.startTime > latest ? occurrence.startTime : latest), null);
}

function isRecorderRecipient(recipient: string, recorderEmail: string, aliases: string[] = []): boolean {
  const normalizedRecipient = normalizeEmailAddress(recipient);
  if (!normalizedRecipient) return false;
  return [recorderEmail, ...aliases].some((email) => email.trim().toLowerCase() === normalizedRecipient);
}

function findSalesRecapSourceRecipient(envelopeRecipient: string, rawEmail: string): string | null {
  return candidateRecipientEmails(envelopeRecipient, rawEmail).find((email) => email === weeklySalesRecapEmail) ?? null;
}

function candidateRecipientEmails(envelopeRecipient: string, rawEmail: string): string[] {
  const candidates = [...extractEmailAddresses(envelopeRecipient)];
  const headers = rawEmail.split(/\r?\n\r?\n/, 1)[0]?.replace(/\r?\n[ \t]+/g, " ") ?? "";
  const recipientHeaders = new Set(["to", "cc", "delivered-to", "x-original-to", "envelope-to", "resent-to", "apparently-to"]);
  for (const line of headers.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!recipientHeaders.has(name)) continue;
    candidates.push(...extractEmailAddresses(line.slice(separator + 1)));
  }
  return Array.from(new Set(candidates));
}

function extractEmailAddresses(value: string): string[] {
  return Array.from(value.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+/gi))
    .map((match) => normalizeEmailAddress(match[0]))
    .filter((email): email is string => Boolean(email));
}

function normalizeEmailAddress(value: string): string | null {
  return extractEmailAddress(value)?.trim().toLowerCase() || null;
}

function extractEmailAddress(value: string): string | null {
  return value.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+/i)?.[0] ?? null;
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
