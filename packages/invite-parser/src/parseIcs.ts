import { AppError } from "@minutesbot/shared";
import { parseIcsDate, parseUtcOffsetToMinutes, type IcsDateContext } from "./icsDates";
import { normalizeAttendees } from "./normalizeAttendees";
import type { ParsedCalendar, RawIcsAttendee } from "./types";

type IcsProperty = {
  name: string;
  params: Map<string, string>;
  value: string;
};

export function parseIcsCalendar(icsText: string): ParsedCalendar {
  const unfolded = unfoldLines(icsText);
  const kind = classifyMethod(readProp(unfolded, "METHOD")?.value);
  // Property lookup is scoped to the first VEVENT so VTIMEZONE sub-blocks
  // (whose STANDARD/DAYLIGHT entries carry their own DTSTART) cannot shadow
  // the event's actual fields.
  const event = eventBlockLines(unfolded);
  const dateContext = buildDateContext(unfolded);

  const uid = readProp(event, "UID");
  const summary = readProp(event, "SUMMARY");
  const dtStart = readProp(event, "DTSTART");
  const dtEnd = readProp(event, "DTEND");
  const organizer = readProp(event, "ORGANIZER");
  const attendees = readProps(event, "ATTENDEE").map(parseAttendeeProperty);

  if (!uid?.value) {
    throw new AppError("INVITE_PARSE_ERROR", "Calendar invite is missing a UID", 400);
  }
  // Cancellations only need the UID to match an existing meeting; Outlook
  // frequently strips other fields from METHOD:CANCEL payloads.
  if (kind !== "cancel" && (!summary || !dtStart || !dtEnd || !organizer)) {
    throw new AppError("INVITE_PARSE_ERROR", "Calendar invite is missing required fields", 400);
  }

  return {
    kind,
    calendarUid: decodeIcsValue(uid.value),
    subject: summary ? decodeIcsValue(summary.value) : "",
    organizer: organizer ? parseOrganizerProperty(organizer, kind === "cancel") : { email: "" },
    attendees: normalizeAttendees(attendees),
    startTime: dtStart ? parseIcsDate(dtStart.value, dtStart.params, dateContext) : "",
    endTime: dtEnd ? parseIcsDate(dtEnd.value, dtEnd.params, dateContext) : "",
    description: decodeIcsValue(readProp(event, "DESCRIPTION")?.value ?? ""),
    location: decodeIcsValue(readProp(event, "LOCATION")?.value ?? "")
  };
}

function classifyMethod(method: string | undefined): ParsedCalendar["kind"] {
  const normalized = method?.trim().toUpperCase();
  if (!normalized || normalized === "REQUEST" || normalized === "PUBLISH") return "request";
  if (normalized === "CANCEL") return "cancel";
  // REPLY/COUNTER/REFRESH etc. are attendee responses, not meeting changes.
  return "other";
}

function unfoldLines(input: string): string[] {
  return input.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function eventBlockLines(lines: string[]): string[] {
  const begin = lines.findIndex((line) => line.trim().toUpperCase() === "BEGIN:VEVENT");
  if (begin === -1) return lines;
  const end = lines.findIndex((line, index) => index > begin && line.trim().toUpperCase() === "END:VEVENT");
  return lines.slice(begin + 1, end === -1 ? undefined : end);
}

function buildDateContext(lines: string[]): IcsDateContext {
  return {
    vtimezoneOffsetMinutes(tzid: string): number | undefined {
      const block = vtimezoneBlock(lines, tzid);
      if (!block) return undefined;
      const standard = subBlock(block, "STANDARD") ?? subBlock(block, "DAYLIGHT");
      const offset = standard ? readProp(standard, "TZOFFSETTO")?.value : undefined;
      return offset ? parseUtcOffsetToMinutes(offset) : undefined;
    }
  };
}

function vtimezoneBlock(lines: string[], tzid: string): string[] | undefined {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const upper = lines[index].trim().toUpperCase();
    if (upper === "BEGIN:VTIMEZONE") start = index;
    if (upper === "END:VTIMEZONE" && start !== -1) {
      const block = lines.slice(start + 1, index);
      const blockTzid = readProp(block, "TZID")?.value;
      if (blockTzid?.trim().replace(/^"|"$/g, "") === tzid.trim().replace(/^"|"$/g, "")) return block;
      start = -1;
    }
  }
  return undefined;
}

function subBlock(lines: string[], name: string): string[] | undefined {
  const begin = lines.findIndex((line) => line.trim().toUpperCase() === `BEGIN:${name}`);
  if (begin === -1) return undefined;
  const end = lines.findIndex((line, index) => index > begin && line.trim().toUpperCase() === `END:${name}`);
  return lines.slice(begin + 1, end === -1 ? undefined : end);
}

function readProp(lines: string[], name: string): IcsProperty | undefined {
  for (const line of lines) {
    const property = tokenizeIcsLine(line);
    if (property?.name === name.toUpperCase()) return property;
  }
  return undefined;
}

function readProps(lines: string[], name: string): IcsProperty[] {
  const properties: IcsProperty[] = [];
  for (const line of lines) {
    const property = tokenizeIcsLine(line);
    if (property?.name === name.toUpperCase()) properties.push(property);
  }
  return properties;
}

/**
 * Splits an ICS content line into name, parameters, and value, honouring
 * double-quoted parameter values that may contain `;`, `:`, or `,`
 * (e.g. `ORGANIZER;CN="Smith: John":mailto:john@company.com`).
 */
function tokenizeIcsLine(line: string): IcsProperty | undefined {
  let inQuotes = false;
  let valueIndex = -1;
  const paramSeparators: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && char === ":") {
      valueIndex = index;
      break;
    } else if (!inQuotes && char === ";") {
      paramSeparators.push(index);
    }
  }
  if (valueIndex === -1) return undefined;

  const boundaries = [...paramSeparators, valueIndex];
  const name = line.slice(0, boundaries[0]).trim().toUpperCase();
  if (!name || !/^[A-Z0-9-]+$/.test(name)) return undefined;

  const params = new Map<string, string>();
  for (let index = 0; index < paramSeparators.length; index += 1) {
    const segment = line.slice(paramSeparators[index] + 1, boundaries[index + 1]);
    const equals = segment.indexOf("=");
    if (equals === -1) continue;
    const key = segment.slice(0, equals).trim().toUpperCase();
    const value = segment.slice(equals + 1).trim().replace(/^"|"$/g, "");
    if (key) params.set(key, value);
  }
  return { name, params, value: line.slice(valueIndex + 1) };
}

function parseOrganizerProperty(property: IcsProperty, lenient: boolean): { email: string; name?: string } {
  const email = extractMailto(property.value);
  const name = property.params.get("CN");
  if (!email) {
    if (lenient) return { email: "" };
    throw new AppError("INVITE_PARSE_ERROR", "Calendar invite organizer is missing email", 400);
  }
  return { email, name: name ? decodeIcsValue(name) : undefined };
}

function parseAttendeeProperty(property: IcsProperty): RawIcsAttendee {
  return {
    email: extractMailto(property.value) ?? "",
    name: property.params.get("CN"),
    role: property.params.get("ROLE")
  };
}

function extractMailto(value: string): string | null {
  const candidate = value.trim().replace(/^"|"$/g, "").replace(/^mailto:/i, "").trim();
  return candidate.includes("@") ? candidate.toLowerCase() : null;
}

export function decodeIcsValue(input: string): string {
  return input.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
