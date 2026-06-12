import { AppError, cleanMeetingSubject } from "@minutesbot/shared";
import { normalizeAttendees } from "./normalizeAttendees";
import { parseRecurrenceRule } from "./recurrence";
import { normalizeIcsTimeZone, zonedDateTimeToUtcDate } from "./timeZones";
import type { ParsedCalendar, RawIcsAttendee } from "./types";

export function parseIcsCalendar(icsText: string): ParsedCalendar {
  const unfolded = unfoldLines(icsText);
  const eventLines = findComponentLines(unfolded, "VEVENT");
  const method = readProp(unfolded, "METHOD")?.toUpperCase();
  const kind = method === "CANCEL" ? "cancel" : "request";
  const uid = readProp(eventLines, "UID");
  const summary = readProp(eventLines, "SUMMARY");
  const dtStart = readPropDetails(eventLines, "DTSTART");
  const dtEnd = readPropDetails(eventLines, "DTEND");
  const recurrenceId = readPropDetails(eventLines, "RECURRENCE-ID");
  const recurrenceRule = readProp(eventLines, "RRULE");
  const organizerLine = findPropLine(eventLines, "ORGANIZER");
  const attendees = findPropLines(eventLines, "ATTENDEE").map(parseAttendeeLine);

  if (!uid || !summary || !dtStart || !dtEnd || !organizerLine) {
    throw new AppError("INVITE_PARSE_ERROR", "Calendar invite is missing required fields", 400);
  }

  const organizer = parseOrganizerLine(organizerLine);
  const decodedUid = decodeIcsText(uid);
  const decodedSummary = decodeIcsText(summary);
  const start = parseIcsDate(dtStart);
  const end = parseIcsDate(dtEnd, start.timeZone);
  const recurrenceIdStart = recurrenceId ? parseIcsDate(recurrenceId, start.timeZone).iso : null;
  const calendarUid = recurrenceIdStart ? `${decodedUid}:${compactIso(recurrenceIdStart)}` : decodedUid;
  const calendarAttendees = normalizeAttendees(attendees);
  return {
    kind,
    calendarUid,
    seriesUid: decodedUid,
    subject: cleanMeetingSubject(decodedSummary) || decodedSummary,
    organizer,
    attendees: calendarAttendees,
    calendarAttendees,
    startTime: start.iso,
    endTime: end.iso,
    ...(start.timeZone ? { timeZone: start.timeZone } : {}),
    recurrence: recurrenceRule ? parseRecurrenceRule(recurrenceRule) : undefined,
    description: decodeIcsText(readProp(eventLines, "DESCRIPTION") ?? ""),
    location: decodeIcsText(readProp(eventLines, "LOCATION") ?? "")
  };
}

function unfoldLines(input: string): string[] {
  return input.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function findPropLine(lines: string[], name: string): string | undefined {
  return lines.find((line) => line.toUpperCase().startsWith(`${name};`) || line.toUpperCase().startsWith(`${name}:`));
}

function findPropLines(lines: string[], name: string): string[] {
  return lines.filter((line) => line.toUpperCase().startsWith(`${name};`) || line.toUpperCase().startsWith(`${name}:`));
}

function findComponentLines(lines: string[], name: string): string[] {
  const begin = `BEGIN:${name.toUpperCase()}`;
  const end = `END:${name.toUpperCase()}`;
  const component: string[] = [];
  let inside = false;

  for (const line of lines) {
    const upperLine = line.toUpperCase();
    if (upperLine === begin) {
      inside = true;
      continue;
    }
    if (upperLine === end && inside) return component;
    if (inside) component.push(line);
  }

  return component;
}

function readProp(lines: string[], name: string): string | undefined {
  const line = findPropLine(lines, name);
  if (!line) return undefined;
  return line.slice(line.indexOf(":") + 1);
}

type IcsProperty = { value: string; params: Map<string, string> };

function readPropDetails(lines: string[], name: string): IcsProperty | undefined {
  const line = findPropLine(lines, name);
  if (!line) return undefined;
  const separator = line.indexOf(":");
  const header = line.slice(0, separator);
  return {
    value: line.slice(separator + 1),
    params: parseParams(header)
  };
}

function parseParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  const parts = header.split(";");
  for (const part of parts.slice(1)) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    params.set(part.slice(0, separator).trim().toUpperCase(), part.slice(separator + 1).trim().replace(/^"|"$/g, ""));
  }
  return params;
}

function parseOrganizerLine(line: string): { email: string; name?: string } {
  const email = extractMailto(line);
  const name = readParam(line, "CN");
  if (!email) throw new AppError("INVITE_PARSE_ERROR", "Calendar invite organizer is missing email", 400);
  return { email: email.toLowerCase(), name: name ? decodeIcsText(name) : undefined };
}

function parseAttendeeLine(line: string): RawIcsAttendee {
  return {
    email: extractMailto(line) ?? "",
    name: readParam(line, "CN"),
    role: readParam(line, "ROLE")
  };
}

function extractMailto(line: string): string | null {
  const value = line.slice(line.indexOf(":") + 1).replace(/^mailto:/i, "");
  return value.includes("@") ? value.trim().toLowerCase() : null;
}

function readParam(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`${key}=("[^"]+"|[^;:]+)`, "i"));
  return match?.[1]?.replace(/^"|"$/g, "");
}

function decodeIcsText(input: string): string {
  return input.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function parseIcsDate(property: IcsProperty, fallbackTimeZone?: string): { iso: string; timeZone?: string } {
  const normalized = property.value.trim();
  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) throw new AppError("INVITE_PARSE_ERROR", `Unsupported calendar date: ${property.value}`, 400);
  const [, year, month, day, hour, minute, second] = match;
  const timeZone = normalizeIcsTimeZone(property.params.get("TZID")) ?? fallbackTimeZone;
  const hasUtcSuffix = normalized.endsWith("Z");
  const date = !hasUtcSuffix && timeZone
    ? zonedDateTimeToUtcDate(
        {
          year: Number(year),
          month: Number(month),
          day: Number(day),
          hour: Number(hour),
          minute: Number(minute),
          second: Number(second)
        },
        timeZone
      )
    : new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return {
    iso: date.toISOString(),
    ...(!hasUtcSuffix && timeZone ? { timeZone } : {})
  };
}

function compactIso(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(".000Z", "Z");
}
