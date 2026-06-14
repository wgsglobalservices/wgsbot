import { AppError } from "@minutesbot/shared";
import { parseIcsDateTime, parseUtcOffsetToMinutes, type IcsDateContext, type IcsDateTime } from "./icsDates";
import { normalizeAttendees } from "./normalizeAttendees";
import type { InviteKind, ParsedCalendar, ParsedVEvent, RawIcsAttendee } from "./types";

type IcsProperty = {
  name: string;
  params: Map<string, string>;
  value: string;
};

/** Parses every VEVENT in a VCALENDAR (series master and/or occurrence overrides), in file order. */
export function parseCalendar(icsText: string): ParsedCalendar {
  const unfolded = unfoldLines(icsText);
  const method = readProp(unfolded, "METHOD")?.value.trim().toUpperCase() || undefined;
  const kind = classifyMethod(method);
  const dateContext = buildDateContext(unfolded);
  // Property lookup is scoped to each VEVENT so VTIMEZONE sub-blocks (whose
  // STANDARD/DAYLIGHT entries carry their own DTSTART) cannot shadow the
  // event's actual fields. Calendars without an explicit VEVENT block fall
  // back to scanning all lines, preserving lenient handling of bare payloads.
  const blocks = eventBlocks(unfolded);
  const events = (blocks.length > 0 ? blocks : [unfolded]).map((block) => parseEventBlock(block, kind, dateContext));
  return { method, kind, events };
}

/**
 * Parses a VCALENDAR down to its primary VEVENT: the series master (no
 * RECURRENCE-ID) when present, otherwise the first event in the file.
 */
export function parseIcsCalendar(icsText: string): ParsedVEvent {
  const calendar = parseCalendar(icsText);
  return calendar.events.find((event) => !event.recurrenceId) ?? calendar.events[0];
}

function parseEventBlock(event: string[], kind: InviteKind, dateContext: IcsDateContext): ParsedVEvent {
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

  const warnings: string[] = [];
  const startDateTime = dtStart ? parseIcsDateTime(dtStart.value, dtStart.params, dateContext) : undefined;
  const endDateTime = dtEnd ? parseIcsDateTime(dtEnd.value, dtEnd.params, dateContext) : undefined;
  const recurrence = readProp(event, "RECURRENCE-ID");
  const sequenceValue = Number.parseInt(readProp(event, "SEQUENCE")?.value.trim() ?? "", 10);
  const rdates = readDateList(event, "RDATE", dateContext, warnings);
  const exdates = readDateList(event, "EXDATE", dateContext, warnings);

  return {
    kind,
    calendarUid: decodeIcsValue(uid.value),
    subject: summary ? decodeIcsValue(summary.value) : "",
    organizer: organizer ? parseOrganizerProperty(organizer, kind === "cancel") : { email: "" },
    attendees: normalizeAttendees(attendees),
    startTime: startDateTime?.utc ?? "",
    endTime: endDateTime?.utc ?? "",
    description: decodeIcsValue(readProp(event, "DESCRIPTION")?.value ?? ""),
    location: decodeIcsValue(readProp(event, "LOCATION")?.value ?? ""),
    startDateTime,
    endDateTime,
    sequence: Number.isNaN(sequenceValue) ? undefined : sequenceValue,
    recurrenceId: recurrence ? parseIcsDateTime(recurrence.value, recurrence.params, dateContext) : undefined,
    recurrenceRange: recurrence?.params.get("RANGE")?.toUpperCase() === "THISANDFUTURE" ? "THISANDFUTURE" : undefined,
    rrule: readProp(event, "RRULE")?.value.trim() || undefined,
    rdates,
    exdates,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/** Reads RDATE/EXDATE properties: multiple lines and comma-separated value lists. */
function readDateList(lines: string[], name: string, context: IcsDateContext, warnings: string[]): IcsDateTime[] | undefined {
  const dates: IcsDateTime[] = [];
  for (const property of readProps(lines, name)) {
    if (property.params.get("VALUE")?.toUpperCase() === "PERIOD") {
      warnings.push(`${name};VALUE=PERIOD is not supported; values ignored`);
      continue;
    }
    for (const value of property.value.split(",")) {
      if (value.trim()) dates.push(parseIcsDateTime(value, property.params, context));
    }
  }
  return dates.length > 0 ? dates : undefined;
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

function eventBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let begin = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const upper = lines[index].trim().toUpperCase();
    if (upper === "BEGIN:VEVENT" && begin === -1) begin = index;
    if (upper === "END:VEVENT" && begin !== -1) {
      blocks.push(lines.slice(begin + 1, index));
      begin = -1;
    }
  }
  // Tolerate a missing END:VEVENT on the final block.
  if (begin !== -1) blocks.push(lines.slice(begin + 1));
  return blocks;
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
