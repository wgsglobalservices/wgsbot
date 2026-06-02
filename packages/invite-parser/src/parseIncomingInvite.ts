import { AppError } from "@minutesbot/shared";
import { extractTeamsJoinUrl } from "./extractTeamsJoinUrl";
import { normalizeAttendees } from "./normalizeAttendees";
import { parseIcsCalendar } from "./parseIcs";
import type { NormalizedAttendee, ParsedMeetingInvite, ParsedRecurrence, RawIcsAttendee } from "./types";

export function parseIncomingInvite(rawEmail: string): ParsedMeetingInvite {
  const headers = parseHeaders(rawEmail);
  const rawRecipient = firstAddress(headers.get("to") ?? headers.get("delivered-to") ?? "");
  const rawSender = firstAddress(headers.get("from") ?? headers.get("sender") ?? "");
  const body = rawEmail.slice(rawEmail.indexOf("\n\n") + 2);
  const calendarText = extractCalendarPart(rawEmail);

  if (!rawRecipient || !rawSender) {
    throw new AppError("INVITE_PARSE_ERROR", "Inbound email is missing sender or recipient", 400);
  }
  if (!calendarText) {
    return parseLinkOnlyInvite({ headers, body, rawRecipient, rawSender });
  }

  const calendar = parseIcsCalendar(calendarText);
  const teamsJoinUrl = extractTeamsJoinUrl(`${calendar.description ?? ""}\n${calendar.location ?? ""}\n${body}`);
  if (!teamsJoinUrl) {
    throw new AppError("REJECTED_NO_TEAMS_LINK", "Meeting invite does not contain a Microsoft Teams join URL", 400);
  }

  return {
    ...calendar,
    attendees: mergeAttendees(calendar.attendees, headerAttendees(headers)),
    teamsJoinUrl,
    rawRecipient: rawRecipient.toLowerCase(),
    rawSender: rawSender.toLowerCase()
  };
}

function parseLinkOnlyInvite(input: { headers: Map<string, string>; body: string; rawRecipient: string; rawSender: string }): ParsedMeetingInvite {
  const teamsJoinUrl = extractTeamsJoinUrl(input.body);
  if (!teamsJoinUrl) {
    throw new AppError("INVITE_PARSE_ERROR", "Inbound email does not include a calendar payload", 400);
  }

  const subject = cleanForwardedSubject(decodeMimeWords(input.headers.get("subject") ?? "").trim()) || "Teams meeting";
  const forwardedEvent = parseForwardedEventDetails(input.body, subject, input.headers.get("date") ?? "");
  const start = forwardedEvent?.start ?? new Date();
  const end = forwardedEvent?.end ?? new Date(start.getTime() + 60 * 60 * 1000);
  return {
    kind: "request",
    calendarUid: `teams-link-${stableHash(teamsJoinUrl)}`,
    subject,
    organizer: { email: input.rawSender.toLowerCase() },
    attendees: headerAttendees(input.headers),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    ...(forwardedEvent?.recurrence ? { recurrence: forwardedEvent.recurrence } : {}),
    teamsJoinUrl,
    rawRecipient: input.rawRecipient.toLowerCase(),
    rawSender: input.rawSender.toLowerCase()
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

function parseHeaders(rawEmail: string): Map<string, string> {
  const headerText = rawEmail.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  return headers;
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

function decodeMimeWords(value: string): string {
  return value.replace(/=\?utf-8\?q\?([^?]+)\?=/gi, (_match, encoded: string) =>
    encoded.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_hexMatch, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  );
}

function cleanForwardedSubject(value: string): string {
  let subject = value.trim();
  while (/^(?:fw|fwd|re)\s*:/i.test(subject)) {
    subject = subject.replace(/^(?:fw|fwd|re)\s*:\s*/i, "").trim();
  }
  return subject;
}

function parseForwardedEventDetails(body: string, subject: string, dateHeader: string): { start: Date; end: Date; recurrence?: ParsedRecurrence } | null {
  const text = normalizeForwardedText(body);
  const offsetMinutes = parseEmailTimezoneOffset(dateHeader);
  const range = parseForwardedWhenRange(text, offsetMinutes);
  if (!range) return null;
  const recurrence = parseForwardedRecurrence(text, subject, range.byDay);
  return {
    start: range.start,
    end: range.end,
    ...(recurrence ? { recurrence } : {})
  };
}

function normalizeForwardedText(input: string): string {
  const decoded = decodeHtmlEntities(decodeQuotedPrintableAscii(input));
  return decoded
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|tr|li|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function decodeQuotedPrintableAscii(input: string): string {
  return input.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code === 10 || code === 13 ? "\n" : String.fromCharCode(code);
  });
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 10)));
}

function parseForwardedWhenRange(text: string, fallbackOffsetMinutes: number): { start: Date; end: Date; byDay: string } | null {
  const whenLine = text.match(/\b(?:when|time)\s*:\s*([^\n]+)/i)?.[1] ?? text;
  const dateParts = parseForwardedDateParts(whenLine);
  if (!dateParts) return null;
  const timeParts = parseForwardedTimeRange(whenLine);
  if (!timeParts) return null;

  const startMs = localDateTimeToUtcMs(dateParts, timeParts.start, fallbackOffsetMinutes);
  let endMs = localDateTimeToUtcMs(dateParts, timeParts.end, fallbackOffsetMinutes);
  if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;

  return {
    start: new Date(startMs),
    end: new Date(endMs),
    byDay: dayCodeForDate(dateParts)
  };
}

function parseForwardedDateParts(value: string): { year: number; month: number; day: number } | null {
  const monthNames = "january|february|march|april|may|june|july|august|september|october|november|december";
  const named = value.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`, "i"));
  if (named) {
    return { year: Number(named[3]), month: monthNameToNumber(named[1]), day: Number(named[2]) };
  }

  const numeric = value.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (!numeric) return null;
  const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]);
  return { year, month: Number(numeric[1]), day: Number(numeric[2]) };
}

function parseForwardedTimeRange(value: string): { start: { hour: number; minute: number }; end: { hour: number; minute: number } } | null {
  const match = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|–|—|\bto\b)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;
  const startMeridiem = match[3];
  const endMeridiem = match[6] ?? startMeridiem;
  return {
    start: { hour: toTwentyFourHour(Number(match[1]), startMeridiem), minute: Number(match[2] ?? 0) },
    end: { hour: toTwentyFourHour(Number(match[4]), endMeridiem), minute: Number(match[5] ?? 0) }
  };
}

function parseForwardedRecurrence(text: string, subject: string, byDay: string): ParsedRecurrence | undefined {
  const dayFromText = text.match(/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i)?.[1];
  const isWeekly = /\bweekly\b/i.test(subject) || /\b(?:occurs|recurs)\s+(?:every\s+)?week(?:ly)?\b/i.test(text) || Boolean(dayFromText);
  if (!isWeekly) return undefined;
  return { frequency: "weekly", interval: /\bevery\s+other\s+week\b/i.test(text) ? 2 : 1, byDay: [dayFromText ? dayNameToCode(dayFromText) : byDay] };
}

function parseEmailTimezoneOffset(value: string): number {
  const match = value.match(/(?:^|\s)([+-])(\d{2})(\d{2})(?:\s|$)/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function localDateTimeToUtcMs(date: { year: number; month: number; day: number }, time: { hour: number; minute: number }, offsetMinutes: number): number {
  return Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0) - offsetMinutes * 60 * 1000;
}

function monthNameToNumber(value: string): number {
  return ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(value.toLowerCase()) + 1;
}

function toTwentyFourHour(hour: number, meridiem: string): number {
  const normalized = hour % 12;
  return meridiem.toLowerCase() === "pm" ? normalized + 12 : normalized;
}

function dayCodeForDate(date: { year: number; month: number; day: number }): string {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
}

function dayNameToCode(value: string): string {
  return ({ sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA" } as const)[value.toLowerCase() as "sunday"] ?? "MO";
}

function extractCalendarPart(rawEmail: string): string | null {
  const begin = rawEmail.indexOf("BEGIN:VCALENDAR");
  const end = rawEmail.indexOf("END:VCALENDAR");
  if (begin === -1 || end === -1) return null;
  return rawEmail.slice(begin, end + "END:VCALENDAR".length);
}
