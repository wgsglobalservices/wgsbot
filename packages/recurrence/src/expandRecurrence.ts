import { RecurrenceError } from "./errors";
import { occurrenceKeyFromIcsDateTime, occurrenceKeyFromMillis } from "./occurrenceKey";
import { parseRrule } from "./parseRrule";
import type { ParsedRrule, RruleByDay, RruleWeekday } from "./parseRrule";
import { wallClockToUtcMillis } from "./timeZone";
import type { ExpandedOccurrence, RecurrenceExpansionInput } from "./types";

const DAY_MS = 86_400_000;
const DEFAULT_MAX_OCCURRENCES = 1000;
// Hard cap on candidate iterations so a pathological rule can never loop forever.
const MAX_ITERATIONS = 100_000;
// No IANA zone offset exceeds 14h, so one day of slack covers wall-clock vs UTC skew.
const WALL_BOUND_SLACK_MS = DAY_MS;

const WEEKDAY_INDEX: Record<RruleWeekday, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function expandRecurrence(input: RecurrenceExpansionInput): ExpandedOccurrence[] {
  const windowStartMs = parseUtcIso(input.windowStart, "windowStart");
  const windowEndMs = parseUtcIso(input.windowEnd, "windowEnd");
  const maxOccurrences = input.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;

  // With a wall clock and zone we iterate in local time so the meeting keeps its
  // local hour across DST; otherwise (UTC or floating) wall time IS UTC time.
  const zone = input.seriesStart.wallClock !== undefined && input.seriesStart.timeZone !== undefined ? input.seriesStart.timeZone : undefined;
  const startWall = zone ? parseWallClock(input.seriesStart.wallClock!) : parseUtcIso(input.seriesStart.utc, "seriesStart.utc");
  const toUtc = (wallMs: number): number => (zone ? wallClockToUtcMillis(wallMs, zone) : wallMs);

  const generated = new Map<string, { startMs: number; isRdate: boolean }>();
  const add = (wallMs: number): void => {
    const utcMs = toUtc(wallMs);
    const key = occurrenceKeyFromMillis(utcMs);
    if (!generated.has(key)) generated.set(key, { startMs: utcMs, isRdate: false });
  };

  if (input.rrule !== undefined && input.rrule.trim() !== "") {
    const rule = parseRrule(input.rrule);
    for (const wallMs of generateRuleInstances(rule, startWall, zone, windowEndMs)) add(wallMs);
  } else {
    add(startWall);
  }

  for (const rdate of input.rdates ?? []) {
    const key = occurrenceKeyFromIcsDateTime(rdate);
    if (!generated.has(key)) {
      generated.set(key, { startMs: parseUtcIso(rdate.utc, "rdate.utc"), isRdate: true });
    }
  }
  // EXDATE removes from the full recurrence set (RRULE + RDATE) after COUNT evaluation.
  for (const exdate of input.exdates ?? []) {
    generated.delete(occurrenceKeyFromIcsDateTime(exdate));
  }

  const occurrences: ExpandedOccurrence[] = [];
  for (const [occurrenceKey, instance] of generated) {
    if (instance.startMs < windowStartMs || instance.startMs >= windowEndMs) continue;
    const occurrence: ExpandedOccurrence = {
      occurrenceKey,
      start: new Date(instance.startMs).toISOString(),
      end: new Date(instance.startMs + input.durationMs).toISOString()
    };
    if (instance.isRdate) occurrence.isRdate = true;
    occurrences.push(occurrence);
  }
  occurrences.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return occurrences.slice(0, maxOccurrences);
}

/** Generates rule instances as wall-clock millis, ascending, DTSTART always first. */
function generateRuleInstances(rule: ParsedRrule, startWall: number, zone: string | undefined, windowEndMs: number): number[] {
  const results = [startWall];
  const wallBound = windowEndMs + WALL_BOUND_SLACK_MS;
  const untilWall = rule.until && !rule.until.isUtc
    ? rule.until.isDateOnly
      ? Date.UTC(rule.until.year, rule.until.month - 1, rule.until.day + 1) - 1
      : Date.UTC(rule.until.year, rule.until.month - 1, rule.until.day, rule.until.hour, rule.until.minute, rule.until.second)
    : undefined;
  const untilUtc = rule.until?.isUtc
    ? Date.UTC(rule.until.year, rule.until.month - 1, rule.until.day, rule.until.hour, rule.until.minute, rule.until.second)
    : undefined;
  const exceedsUntil = (wallMs: number): boolean => {
    if (untilWall !== undefined) return wallMs > untilWall;
    if (untilUtc !== undefined) return (zone ? wallClockToUtcMillis(wallMs, zone) : wallMs) > untilUtc;
    return false;
  };

  let produced = 1;
  let iterations = 0;
  const guard = (): void => {
    iterations += 1;
    if (iterations > MAX_ITERATIONS) {
      throw new RecurrenceError(`Recurrence expansion exceeded the safety cap of ${MAX_ITERATIONS} iterations`);
    }
  };

  outer: for (let period = 0; rule.count === undefined || produced < rule.count; period += 1) {
    guard();
    const { periodStart, instances } = candidatesForPeriod(rule, startWall, period);
    if (periodStart > wallBound) break;
    for (const wallMs of instances) {
      guard();
      // DTSTART is already included; candidates before it are not part of the series.
      if (wallMs <= startWall) continue;
      if (exceedsUntil(wallMs)) break outer;
      if (wallMs > wallBound) break outer;
      results.push(wallMs);
      produced += 1;
      if (rule.count !== undefined && produced >= rule.count) break outer;
    }
  }
  return results;
}

function candidatesForPeriod(rule: ParsedRrule, startWall: number, period: number): { periodStart: number; instances: number[] } {
  const timeOfDay = startWall - startOfUtcDay(startWall);
  const start = new Date(startWall);

  switch (rule.freq) {
    case "DAILY": {
      const day = startOfUtcDay(startWall) + period * rule.interval * DAY_MS;
      const matches =
        (rule.byMonth === undefined || rule.byMonth.includes(utcMonth(day))) &&
        (rule.byMonthDay === undefined || matchesMonthDay(day, rule.byMonthDay)) &&
        (rule.byDay === undefined || rule.byDay.some((entry) => WEEKDAY_INDEX[entry.weekday] === utcWeekday(day)));
      return { periodStart: day, instances: matches ? [day + timeOfDay] : [] };
    }
    case "WEEKLY": {
      const wkstIndex = WEEKDAY_INDEX[rule.wkst];
      const baseWeek = startOfWeek(startOfUtcDay(startWall), wkstIndex);
      const weekStart = baseWeek + period * rule.interval * 7 * DAY_MS;
      const wantedWeekdays = rule.byDay
        ? new Set(rule.byDay.map((entry) => WEEKDAY_INDEX[entry.weekday]))
        : new Set([utcWeekday(startWall)]);
      const instances: number[] = [];
      for (let offset = 0; offset < 7; offset += 1) {
        const day = weekStart + offset * DAY_MS;
        if (!wantedWeekdays.has(utcWeekday(day))) continue;
        if (rule.byMonth !== undefined && !rule.byMonth.includes(utcMonth(day))) continue;
        instances.push(day + timeOfDay);
      }
      return { periodStart: weekStart, instances };
    }
    case "MONTHLY": {
      const monthIndex = start.getUTCFullYear() * 12 + start.getUTCMonth() + period * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = monthIndex - year * 12;
      const periodStart = Date.UTC(year, month, 1);
      if (rule.byMonth !== undefined && !rule.byMonth.includes(month + 1)) {
        return { periodStart, instances: [] };
      }
      const days = expandMonthDays(rule, year, month, start.getUTCDate());
      return { periodStart, instances: applySetPos(days, rule.bySetPos).map((day) => day + timeOfDay) };
    }
    case "YEARLY": {
      const year = start.getUTCFullYear() + period * rule.interval;
      const periodStart = Date.UTC(year, 0, 1);
      const months = (rule.byMonth ?? [start.getUTCMonth() + 1]).slice().sort((a, b) => a - b);
      const days: number[] = [];
      for (const month of months) {
        days.push(...expandMonthDays(rule, year, month - 1, start.getUTCDate()));
      }
      return { periodStart, instances: applySetPos(days, rule.bySetPos).map((day) => day + timeOfDay) };
    }
  }
}

/** Day-start millis (sorted) for a month, per BYMONTHDAY / BYDAY / DTSTART day-of-month. */
function expandMonthDays(rule: ParsedRrule, year: number, month: number, fallbackDayOfMonth: number): number[] {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const days = new Set<number>();

  if (rule.byMonthDay !== undefined) {
    for (const monthDay of rule.byMonthDay) {
      const day = monthDay > 0 ? monthDay : daysInMonth + monthDay + 1;
      if (day < 1 || day > daysInMonth) continue;
      if (rule.byDay !== undefined && !byDayIncludesWeekday(rule.byDay, utcWeekday(Date.UTC(year, month, day)))) continue;
      days.add(day);
    }
  } else if (rule.byDay !== undefined) {
    for (const entry of rule.byDay) {
      const matches: number[] = [];
      for (let day = 1; day <= daysInMonth; day += 1) {
        if (utcWeekday(Date.UTC(year, month, day)) === WEEKDAY_INDEX[entry.weekday]) matches.push(day);
      }
      if (entry.ordinal === undefined) {
        for (const day of matches) days.add(day);
      } else {
        const picked = entry.ordinal > 0 ? matches[entry.ordinal - 1] : matches[matches.length + entry.ordinal];
        if (picked !== undefined) days.add(picked);
      }
    }
  } else if (fallbackDayOfMonth <= daysInMonth) {
    // Months too short for DTSTART's day-of-month (e.g. the 31st) are skipped.
    days.add(fallbackDayOfMonth);
  }

  return [...days].sort((a, b) => a - b).map((day) => Date.UTC(year, month, day));
}

function applySetPos(days: number[], bySetPos: number[] | undefined): number[] {
  if (bySetPos === undefined) return days;
  const picked = new Set<number>();
  for (const pos of bySetPos) {
    const index = pos > 0 ? pos - 1 : days.length + pos;
    if (index >= 0 && index < days.length) picked.add(days[index]);
  }
  return [...picked].sort((a, b) => a - b);
}

function byDayIncludesWeekday(byDay: RruleByDay[], weekdayIndex: number): boolean {
  return byDay.some((entry) => WEEKDAY_INDEX[entry.weekday] === weekdayIndex);
}

function matchesMonthDay(dayStartMs: number, byMonthDay: number[]): boolean {
  const date = new Date(dayStartMs);
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return byMonthDay.some((monthDay) => (monthDay > 0 ? monthDay : daysInMonth + monthDay + 1) === date.getUTCDate());
}

function startOfUtcDay(millis: number): number {
  return Math.floor(millis / DAY_MS) * DAY_MS;
}

function startOfWeek(dayStartMs: number, wkstIndex: number): number {
  const diff = (utcWeekday(dayStartMs) - wkstIndex + 7) % 7;
  return dayStartMs - diff * DAY_MS;
}

function utcWeekday(millis: number): number {
  return new Date(millis).getUTCDay();
}

function utcMonth(millis: number): number {
  return new Date(millis).getUTCMonth() + 1;
}

function parseUtcIso(value: string, label: string): number {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw new RecurrenceError(`Invalid UTC ISO value for ${label}: ${value}`);
  return millis;
}

function parseWallClock(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) throw new RecurrenceError(`Invalid wall clock value: ${value}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}
