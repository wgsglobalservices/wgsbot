export type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
};

const windowsTimeZones = new Map<string, string>([
  ["utc", "UTC"],
  ["coordinated universal time", "UTC"],
  ["eastern standard time", "America/New_York"],
  ["central standard time", "America/Chicago"],
  ["mountain standard time", "America/Denver"],
  ["pacific standard time", "America/Los_Angeles"],
  ["alaskan standard time", "America/Anchorage"],
  ["hawaiian standard time", "Pacific/Honolulu"],
  ["gmt standard time", "Europe/London"],
  ["w. europe standard time", "Europe/Berlin"],
  ["central europe standard time", "Europe/Budapest"],
  ["romance standard time", "Europe/Paris"],
  ["tokyo standard time", "Asia/Tokyo"],
  ["china standard time", "Asia/Shanghai"],
  ["india standard time", "Asia/Kolkata"],
  ["aus eastern standard time", "Australia/Sydney"]
]);

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function normalizeIcsTimeZone(value: string | undefined): string | undefined {
  const cleaned = value?.trim().replace(/^"|"$/g, "");
  if (!cleaned) return undefined;
  const mapped = windowsTimeZones.get(cleaned.toLowerCase()) ?? cleaned;
  return isSupportedTimeZone(mapped) ? mapped : undefined;
}

export function getZonedParts(value: Date, timeZone: string): LocalDateTimeParts {
  const parts = formatterFor(timeZone).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
    millisecond: value.getUTCMilliseconds()
  };
}

export function zonedDateTimeToUtcDate(parts: LocalDateTimeParts, timeZone: string): Date {
  const targetAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond ?? 0);
  let candidate = targetAsUtc;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const zoned = getZonedParts(new Date(candidate), timeZone);
    const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second, parts.millisecond ?? 0);
    const diff = targetAsUtc - zonedAsUtc;
    if (diff === 0) break;
    candidate += diff;
  }

  return new Date(candidate);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function isSupportedTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}
