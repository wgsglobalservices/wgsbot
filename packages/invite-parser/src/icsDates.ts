import { AppError } from "@minutesbot/shared";
import { windowsToIanaTimeZone } from "./windowsTimeZones";

export type IcsDateContext = {
  /** Resolves a TZID to a fixed UTC offset in minutes from a VTIMEZONE block, when available. */
  vtimezoneOffsetMinutes(tzid: string): number | undefined;
};

export type IcsDateTime = {
  /** ISO UTC instant. */
  utc: string;
  /** "YYYY-MM-DDTHH:MM:SS" as written in the ICS (local). */
  wallClock?: string;
  /** Resolved IANA zone when known (Windows display names are mapped). */
  timeZone?: string;
  /** True for VALUE=DATE all-day values. */
  isDate?: boolean;
};

/**
 * Converts an ICS DTSTART/DTEND value to a UTC ISO string.
 *
 * Supported forms: `...Z` (UTC), `TZID=<zone>` local times (IANA ids and
 * Windows display names), floating local times (interpreted as UTC), and
 * `VALUE=DATE` all-day values (midnight in the named zone).
 * Unknown TZIDs degrade to a VTIMEZONE standard offset when present,
 * otherwise to UTC — never worse than rejecting the invite outright.
 */
export function parseIcsDate(value: string, params: Map<string, string>, context?: IcsDateContext): string {
  return parseIcsDateTime(value, params, context).utc;
}

/** Structured variant of {@link parseIcsDate} that also keeps the wall-clock time and zone. */
export function parseIcsDateTime(value: string, params: Map<string, string>, context?: IcsDateContext): IcsDateTime {
  const normalized = value.trim();
  const tzid = params.get("TZID");

  const dateOnly = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly || params.get("VALUE")?.toUpperCase() === "DATE") {
    const match = dateOnly ?? normalized.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!match) throw new AppError("INVITE_PARSE_ERROR", `Unsupported calendar date: ${value}`, 400);
    return {
      utc: zonedTimeToUtcIso(Number(match[1]), Number(match[2]), Number(match[3]), 0, 0, 0, tzid, context),
      wallClock: `${match[1]}-${match[2]}-${match[3]}T00:00:00`,
      timeZone: tzid ? resolveIanaTimeZone(tzid) : undefined,
      isDate: true
    };
  }

  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) throw new AppError("INVITE_PARSE_ERROR", `Unsupported calendar date: ${value}`, 400);
  const [, year, month, day, hour, minute, second, zulu] = match;
  const parts = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second)] as const;
  const wallClock = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

  if (zulu === "Z") {
    return {
      utc: new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])).toISOString(),
      wallClock,
      timeZone: "UTC"
    };
  }
  return {
    utc: zonedTimeToUtcIso(...parts, tzid, context),
    wallClock,
    timeZone: tzid ? resolveIanaTimeZone(tzid) : undefined
  };
}

function zonedTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzid: string | undefined,
  context?: IcsDateContext
): string {
  const asUtcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(asUtcMillis)) {
    throw new AppError("INVITE_PARSE_ERROR", "Calendar date is out of range", 400);
  }
  if (!tzid) return new Date(asUtcMillis).toISOString();

  const ianaZone = resolveIanaTimeZone(tzid);
  if (ianaZone) {
    // Two-pass conversion: estimate the offset at the wall-clock instant, then
    // re-evaluate at the corrected instant so DST transitions resolve correctly.
    const firstOffset = timeZoneOffsetMillis(asUtcMillis, ianaZone);
    const secondOffset = timeZoneOffsetMillis(asUtcMillis - firstOffset, ianaZone);
    return new Date(asUtcMillis - secondOffset).toISOString();
  }

  const fallbackOffsetMinutes = context?.vtimezoneOffsetMinutes(tzid);
  if (fallbackOffsetMinutes !== undefined) {
    return new Date(asUtcMillis - fallbackOffsetMinutes * 60_000).toISOString();
  }
  return new Date(asUtcMillis).toISOString();
}

function resolveIanaTimeZone(tzid: string): string | undefined {
  const trimmed = tzid.trim().replace(/^"|"$/g, "");
  if (isValidTimeZone(trimmed)) return trimmed;
  const mapped = windowsToIanaTimeZone(trimmed);
  if (mapped && isValidTimeZone(mapped)) return mapped;
  return undefined;
}

function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `zone` from UTC (positive when ahead of UTC) at the given instant. */
function timeZoneOffsetMillis(utcMillis: number, zone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(new Date(utcMillis));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const zonedAsUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return zonedAsUtc - utcMillis;
}

/** Parses `TZOFFSETTO` values such as `+0530`, `-08`, `+023045` into minutes. */
export function parseUtcOffsetToMinutes(value: string): number | undefined {
  const match = value.trim().match(/^([+-])(\d{2})(\d{2})?(\d{2})?$/);
  if (!match) return undefined;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  return sign * (hours * 60 + minutes);
}
