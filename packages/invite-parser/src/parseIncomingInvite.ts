import { AppError } from "@minutesbot/shared";
import { extractTeamsJoinUrl } from "./extractTeamsJoinUrl";
import { decodeMimeWords, extractCalendarText, extractTextBody, parseHeaderBlock, splitMessage } from "./mime";
import { normalizeAttendees } from "./normalizeAttendees";
import { parseCalendar } from "./parseIcs";
import type { NormalizedAttendee, ParsedMeetingInvite, ParsedVEvent, RawIcsAttendee } from "./types";

export function parseIncomingInvite(rawEmail: string): ParsedMeetingInvite {
  const { headerText } = splitMessage(rawEmail);
  const headers = parseHeaderBlock(headerText);
  const rawRecipient = firstAddress(headers.get("to") ?? headers.get("delivered-to") ?? "");
  const rawSender = firstAddress(headers.get("from") ?? headers.get("sender") ?? "");
  const body = extractTextBody(rawEmail);
  const calendarText = extractCalendarText(rawEmail);

  if (!rawRecipient || !rawSender) {
    throw new AppError("INVITE_PARSE_ERROR", "Inbound email is missing sender or recipient", 400);
  }
  if (!calendarText) {
    return parseLinkOnlyInvite({ headers, body, rawRecipient, rawSender });
  }

  const calendar = parseCalendar(calendarText);
  // The primary event is the series master (no RECURRENCE-ID) when present,
  // otherwise the first event in the file.
  const primary = calendar.events.find((event) => !event.recurrenceId) ?? calendar.events[0];
  const teamsJoinUrl = extractTeamsJoinUrl(`${primary.description ?? ""}\n${primary.location ?? ""}\n${body}`);
  // Cancellations are matched to the stored meeting by UID, so a missing
  // join URL must not reject them — otherwise the bot attends cancelled
  // meetings whose CANCEL payload omitted the link.
  if (!teamsJoinUrl && primary.kind === "request") {
    throw new AppError("REJECTED_NO_TEAMS_LINK", "Meeting invite does not contain a Microsoft Teams join URL", 400);
  }

  return {
    ...primary,
    attendees: mergeAttendees(primary.attendees, headerAttendees(headers)),
    teamsJoinUrl,
    rawRecipient: rawRecipient.toLowerCase(),
    rawSender: rawSender.toLowerCase(),
    events: calendar.events
  };
}

function parseLinkOnlyInvite(input: { headers: Map<string, string>; body: string; rawRecipient: string; rawSender: string }): ParsedMeetingInvite {
  const teamsJoinUrl = extractTeamsJoinUrl(input.body);
  if (!teamsJoinUrl) {
    throw new AppError("INVITE_PARSE_ERROR", "Inbound email does not include a calendar payload", 400);
  }

  const start = new Date();
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const event: ParsedVEvent = {
    kind: "request",
    calendarUid: `teams-link-${stableHash(teamsJoinUrl)}`,
    subject: decodeMimeWords(input.headers.get("subject") ?? "").trim() || "Teams meeting",
    organizer: { email: input.rawSender.toLowerCase() },
    attendees: headerAttendees(input.headers),
    startTime: start.toISOString(),
    endTime: end.toISOString()
  };
  return {
    ...event,
    teamsJoinUrl,
    rawRecipient: input.rawRecipient.toLowerCase(),
    rawSender: input.rawSender.toLowerCase(),
    events: [event]
  };
}

function headerAttendees(headers: Map<string, string>): NormalizedAttendee[] {
  return normalizeAttendees([...parseAddressList(headers.get("to") ?? ""), ...parseAddressList(headers.get("cc") ?? ""), ...parseAddressList(headers.get("bcc") ?? "")]);
}

function parseAddressList(value: string): RawIcsAttendee[] {
  return splitAddressList(value).map(parseAddress).filter((attendee): attendee is RawIcsAttendee => Boolean(attendee));
}

function splitAddressList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

function parseAddress(value: string): RawIcsAttendee | null {
  const angle = value.match(/<([^>]+)>/);
  const email = (angle?.[1] ?? value).trim().replace(/^mailto:/i, "").toLowerCase();
  if (!email.includes("@")) return null;
  const rawName = angle ? value.slice(0, value.indexOf("<")).trim().replace(/^"|"$/g, "") : "";
  const name = rawName ? decodeMimeWords(rawName) : undefined;
  return { email, name };
}

function mergeAttendees(primary: NormalizedAttendee[], fallback: NormalizedAttendee[]): NormalizedAttendee[] {
  const seen = new Set<string>();
  const merged: NormalizedAttendee[] = [];
  for (const attendee of [...primary, ...fallback]) {
    if (seen.has(attendee.email)) continue;
    seen.add(attendee.email);
    merged.push(attendee);
  }
  return merged;
}

function firstAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  const candidate = angle?.[1] ?? value.split(",")[0] ?? "";
  return candidate.trim().replace(/^mailto:/i, "");
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
