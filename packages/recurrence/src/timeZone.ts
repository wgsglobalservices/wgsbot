import { RecurrenceError } from "./errors";

const DAY_MS = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
  } catch {
    throw new RecurrenceError(`Unknown IANA time zone: ${zone}`);
  }
  formatterCache.set(zone, formatter);
  return formatter;
}

/** Offset of `zone` from UTC (positive when ahead of UTC) at the given instant. */
export function timeZoneOffsetMillis(utcMillis: number, zone: string): number {
  const parts = getFormatter(zone).formatToParts(new Date(utcMillis));
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const zonedAsUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second"));
  return zonedAsUtc - utcMillis;
}

/**
 * Converts a wall-clock instant (local fields encoded as if UTC) in `zone` to a real UTC instant.
 * Ambiguous local times (fall-back) resolve to the FIRST occurrence (pre-transition offset).
 * Nonexistent local times (spring-forward gap) shift forward by the offset delta.
 */
export function wallClockToUtcMillis(wallMillis: number, zone: string): number {
  const offsetBefore = timeZoneOffsetMillis(wallMillis - DAY_MS, zone);
  const offsetAfter = timeZoneOffsetMillis(wallMillis + DAY_MS, zone);
  const candidates = offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];
  const valid = candidates.filter((offset) => timeZoneOffsetMillis(wallMillis - offset, zone) === offset);
  if (valid.length === 1) return wallMillis - valid[0];
  // Ambiguous: the larger offset is pre-transition and yields the earlier UTC instant.
  if (valid.length > 1) return wallMillis - Math.max(...valid);
  // Gap: applying the pre-transition (smaller) offset shifts the result forward by the delta.
  return wallMillis - Math.min(offsetBefore, offsetAfter);
}
