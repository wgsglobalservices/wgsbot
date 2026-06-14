import { RecurrenceError } from "./errors";

export type RruleFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type RruleWeekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

export type RruleByDay = {
  weekday: RruleWeekday;
  /** Ordinal prefix for MONTHLY/YEARLY, e.g. 2 for "2TU", -1 for "-1FR". */
  ordinal?: number;
};

export type RruleUntil = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** True for the `...Z` form — compared as a UTC instant. */
  isUtc: boolean;
  /** True for the `YYYYMMDD` form — inclusive through the whole local date. */
  isDateOnly: boolean;
};

export type ParsedRrule = {
  freq: RruleFreq;
  interval: number;
  count?: number;
  until?: RruleUntil;
  byDay?: RruleByDay[];
  byMonthDay?: number[];
  byMonth?: number[];
  bySetPos?: number[];
  wkst: RruleWeekday;
};

const FREQS = new Set<string>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const SUB_DAILY_FREQS = new Set<string>(["SECONDLY", "MINUTELY", "HOURLY"]);
const WEEKDAYS = new Set<string>(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
const UNSUPPORTED_PARTS = new Set<string>(["BYSECOND", "BYMINUTE", "BYHOUR", "BYWEEKNO", "BYYEARDAY"]);

export function parseRrule(value: string): ParsedRrule {
  const raw = value.trim().replace(/^RRULE:/i, "");
  if (raw === "") throw new RecurrenceError("Empty RRULE value");

  const parts = new Map<string, string>();
  for (const segment of raw.split(";")) {
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    if (eq <= 0) throw new RecurrenceError(`Malformed RRULE part: ${segment}`);
    const key = segment.slice(0, eq).trim().toUpperCase();
    if (parts.has(key)) throw new RecurrenceError(`Duplicate RRULE part: ${key}`);
    parts.set(key, segment.slice(eq + 1).trim().toUpperCase());
  }

  for (const key of parts.keys()) {
    if (UNSUPPORTED_PARTS.has(key)) throw new RecurrenceError(`Unsupported RRULE part: ${key}`);
  }

  const freqValue = parts.get("FREQ");
  if (freqValue === undefined) throw new RecurrenceError("RRULE is missing FREQ");
  if (SUB_DAILY_FREQS.has(freqValue)) throw new RecurrenceError(`Unsupported RRULE frequency: ${freqValue}`);
  if (!FREQS.has(freqValue)) throw new RecurrenceError(`Invalid RRULE frequency: ${freqValue}`);
  const freq = freqValue as RruleFreq;

  const known = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"]);
  for (const key of parts.keys()) {
    if (!known.has(key)) throw new RecurrenceError(`Unsupported RRULE part: ${key}`);
  }

  const interval = parsePositiveInt(parts.get("INTERVAL"), "INTERVAL") ?? 1;
  const count = parsePositiveInt(parts.get("COUNT"), "COUNT");
  const until = parts.has("UNTIL") ? parseUntil(parts.get("UNTIL")!) : undefined;
  if (count !== undefined && until !== undefined) {
    throw new RecurrenceError("RRULE cannot specify both COUNT and UNTIL");
  }

  const byDay = parts.has("BYDAY") ? parseByDay(parts.get("BYDAY")!, freq) : undefined;
  const byMonthDay = parts.has("BYMONTHDAY")
    ? parseIntList(parts.get("BYMONTHDAY")!, "BYMONTHDAY", (v) => v !== 0 && Math.abs(v) <= 31)
    : undefined;
  const byMonth = parts.has("BYMONTH") ? parseIntList(parts.get("BYMONTH")!, "BYMONTH", (v) => v >= 1 && v <= 12) : undefined;
  const bySetPos = parts.has("BYSETPOS")
    ? parseIntList(parts.get("BYSETPOS")!, "BYSETPOS", (v) => v !== 0 && Math.abs(v) <= 366)
    : undefined;

  if (bySetPos !== undefined && byDay === undefined && byMonthDay === undefined && byMonth === undefined) {
    throw new RecurrenceError("BYSETPOS requires another BYxxx part (Outlook emits it with BYDAY)");
  }
  if (freq === "YEARLY" && byDay !== undefined && byMonth === undefined) {
    throw new RecurrenceError("Unsupported RRULE: YEARLY BYDAY without BYMONTH (nth weekday of the year)");
  }

  const wkstValue = parts.get("WKST");
  if (wkstValue !== undefined && !WEEKDAYS.has(wkstValue)) {
    throw new RecurrenceError(`Invalid WKST value: ${wkstValue}`);
  }
  const wkst = (wkstValue ?? "MO") as RruleWeekday;

  return { freq, interval, count, until, byDay, byMonthDay, byMonth, bySetPos, wkst };
}

function parsePositiveInt(value: string | undefined, part: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new RecurrenceError(`Invalid ${part} value: ${value}`);
  const parsed = Number(value);
  if (parsed < 1) throw new RecurrenceError(`Invalid ${part} value: ${value}`);
  return parsed;
}

function parseIntList(value: string, part: string, isValid: (v: number) => boolean): number[] {
  return value.split(",").map((entry) => {
    if (!/^[+-]?\d+$/.test(entry)) throw new RecurrenceError(`Invalid ${part} entry: ${entry}`);
    const parsed = Number(entry);
    if (!isValid(parsed)) throw new RecurrenceError(`Invalid ${part} entry: ${entry}`);
    return parsed;
  });
}

function parseByDay(value: string, freq: RruleFreq): RruleByDay[] {
  return value.split(",").map((entry) => {
    const match = entry.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    if (!match) throw new RecurrenceError(`Invalid BYDAY entry: ${entry}`);
    const weekday = match[2] as RruleWeekday;
    if (match[1] === undefined) return { weekday };
    const ordinal = Number(match[1]);
    if (ordinal === 0 || Math.abs(ordinal) > 53) throw new RecurrenceError(`Invalid BYDAY ordinal: ${entry}`);
    if (freq !== "MONTHLY" && freq !== "YEARLY") {
      throw new RecurrenceError(`BYDAY ordinal prefix is only supported for MONTHLY/YEARLY: ${entry}`);
    }
    return { weekday, ordinal };
  });
}

function parseUntil(value: string): RruleUntil {
  const dateTime = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (dateTime) {
    return {
      year: Number(dateTime[1]),
      month: Number(dateTime[2]),
      day: Number(dateTime[3]),
      hour: Number(dateTime[4]),
      minute: Number(dateTime[5]),
      second: Number(dateTime[6]),
      isUtc: dateTime[7] === "Z",
      isDateOnly: false
    };
  }
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    return {
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
      hour: 0,
      minute: 0,
      second: 0,
      isUtc: false,
      isDateOnly: true
    };
  }
  throw new RecurrenceError(`Invalid UNTIL value: ${value}`);
}
