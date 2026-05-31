import { AppError } from "@minutesbot/shared";
import { normalizeAttendees } from "./normalizeAttendees";
import { parseRecurrenceRule } from "./recurrence";
import type { ParsedCalendar, RawIcsAttendee } from "./types";

export function parseIcsCalendar(icsText: string): ParsedCalendar {
  const unfolded = unfoldLines(icsText);
  const eventLines = findComponentLines(unfolded, "VEVENT");
  const method = readProp(unfolded, "METHOD")?.toUpperCase();
  const kind = method === "CANCEL" ? "cancel" : "request";
  const uid = readProp(eventLines, "UID");
  const summary = readProp(eventLines, "SUMMARY");
  const dtStart = readProp(eventLines, "DTSTART");
  const dtEnd = readProp(eventLines, "DTEND");
  const recurrenceId = readProp(eventLines, "RECURRENCE-ID");
  const recurrenceRule = readProp(eventLines, "RRULE");
  const organizerLine = findPropLine(eventLines, "ORGANIZER");
  const attendees = findPropLines(eventLines, "ATTENDEE").map(parseAttendeeLine);

  if (!uid || !summary || !dtStart || !dtEnd || !organizerLine) {
    throw new AppError("INVITE_PARSE_ERROR", "Calendar invite is missing required fields", 400);
  }

  const organizer = parseOrganizerLine(organizerLine);
  const decodedUid = decodeIcsText(uid);
  const calendarUid = recurrenceId ? `${decodedUid}:${compactIso(parseIcsDate(recurrenceId))}` : decodedUid;
  return {
    kind,
    calendarUid,
    subject: decodeIcsText(summary),
    organizer,
    attendees: normalizeAttendees(attendees),
    startTime: parseIcsDate(dtStart),
    endTime: parseIcsDate(dtEnd),
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

function parseIcsDate(value: string): string {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) throw new AppError("INVITE_PARSE_ERROR", `Unsupported calendar date: ${value}`, 400);
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))).toISOString();
}

function compactIso(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(".000Z", "Z");
}
