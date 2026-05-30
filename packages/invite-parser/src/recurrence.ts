import type { MeetingOccurrence, ParsedMeetingInvite, ParsedRecurrence } from "./types";

const DEFAULT_HORIZON_DAYS = 180;
const DEFAULT_MAX_OCCURRENCES = 60;
const MAX_EXPANSION_STEPS = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_BY_DAYS = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
const WEEK_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

export function parseRecurrenceRule(rule: string): ParsedRecurrence | undefined {
  const fields = new Map(
    rule
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [key, ...valueParts] = part.split("=");
        return [key.toUpperCase(), valueParts.join("=")] as const;
      })
  );
  const frequency = parseFrequency(fields.get("FREQ"));
  if (!frequency) return undefined;

  const interval = parsePositiveInteger(fields.get("INTERVAL")) ?? 1;
  const count = parsePositiveInteger(fields.get("COUNT"));
  const until = fields.get("UNTIL") ? parseIcsDateValue(fields.get("UNTIL") ?? "") : undefined;
  const byDay = parseByDay(fields.get("BYDAY"));
  return {
    frequency,
    interval,
    ...(count ? { count } : {}),
    ...(until ? { until } : {}),
    ...(byDay.length > 0 ? { byDay } : {})
  };
}

export function expandInviteOccurrences(
  invite: ParsedMeetingInvite,
  options: { now?: Date; horizonDays?: number; maxOccurrences?: number } = {}
): MeetingOccurrence[] {
  if (!invite.recurrence) {
    return [
      {
        calendarUid: invite.calendarUid,
        seriesUid: invite.calendarUid,
        startTime: invite.startTime,
        endTime: invite.endTime,
        occurrenceIndex: 0,
        recurring: false
      }
    ];
  }

  const now = options.now ?? new Date();
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const maxOccurrences = options.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES;
  const windowStart = now.getTime();
  const horizonEnd = windowStart + horizonDays * DAY_MS;
  const start = new Date(invite.startTime);
  const end = new Date(invite.endTime);
  const durationMs = Math.max(0, end.getTime() - start.getTime());
  const untilMs = invite.recurrence.until ? new Date(invite.recurrence.until).getTime() : null;
  const occurrences: MeetingOccurrence[] = [];

  if (invite.recurrence.frequency === "weekly" && invite.recurrence.byDay && invite.recurrence.byDay.length > 0) {
    return expandWeeklyByDayOccurrences(invite, { start, durationMs, windowStart, horizonEnd, untilMs, maxOccurrences });
  }

  for (let index = 0; index < MAX_EXPANSION_STEPS && occurrences.length < maxOccurrences; index += 1) {
    if (invite.recurrence.count && index >= invite.recurrence.count) break;
    const occurrenceStart = advanceDate(start, invite.recurrence, index);
    const startMs = occurrenceStart.getTime();
    if (untilMs !== null && startMs > untilMs) break;
    if (startMs > horizonEnd) break;

    const occurrenceEnd = new Date(startMs + durationMs);
    if (occurrenceEnd.getTime() >= windowStart) {
      const startTime = occurrenceStart.toISOString();
      occurrences.push({
        calendarUid: `${invite.calendarUid}:${compactIso(startTime)}`,
        seriesUid: invite.calendarUid,
        startTime,
        endTime: occurrenceEnd.toISOString(),
        occurrenceIndex: index,
        recurring: true
      });
    }
  }

  return occurrences;
}

function expandWeeklyByDayOccurrences(
  invite: ParsedMeetingInvite,
  input: { start: Date; durationMs: number; windowStart: number; horizonEnd: number; untilMs: number | null; maxOccurrences: number }
): MeetingOccurrence[] {
  if (!invite.recurrence) return [];
  const days = [...new Set(invite.recurrence.byDay?.map(dayToIndex).filter((day): day is number => day !== null) ?? [])].sort((left, right) => left - right);
  if (days.length === 0) return [];

  const occurrences: MeetingOccurrence[] = [];
  const startMs = input.start.getTime();
  const startWeek = startOfUtcWeek(input.start);
  let occurrenceIndex = 0;

  for (let weekIndex = 0; weekIndex < MAX_EXPANSION_STEPS && occurrences.length < input.maxOccurrences; weekIndex += 1) {
    const weekStart = new Date(startWeek.getTime() + weekIndex * invite.recurrence.interval * 7 * DAY_MS);
    for (const day of days) {
      if (invite.recurrence.count && occurrenceIndex >= invite.recurrence.count) return occurrences;
      const occurrenceStart = withUtcTime(new Date(weekStart.getTime() + day * DAY_MS), input.start);
      const startTimeMs = occurrenceStart.getTime();
      if (startTimeMs < startMs) continue;
      if (input.untilMs !== null && startTimeMs > input.untilMs) return occurrences;
      if (startTimeMs > input.horizonEnd) return occurrences;

      const occurrenceEnd = new Date(startTimeMs + input.durationMs);
      if (occurrenceEnd.getTime() >= input.windowStart) {
        const startTime = occurrenceStart.toISOString();
        occurrences.push({
          calendarUid: `${invite.calendarUid}:${compactIso(startTime)}`,
          seriesUid: invite.calendarUid,
          startTime,
          endTime: occurrenceEnd.toISOString(),
          occurrenceIndex,
          recurring: true
        });
      }
      occurrenceIndex += 1;
    }
  }

  return occurrences;
}

function parseFrequency(value: string | undefined): ParsedRecurrence["frequency"] | undefined {
  switch (value?.toUpperCase()) {
    case "DAILY":
      return "daily";
    case "WEEKLY":
      return "weekly";
    case "MONTHLY":
      return "monthly";
    case "YEARLY":
      return "yearly";
    default:
      return undefined;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseByDay(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((day) => day.trim().toUpperCase().replace(/^[+-]?\d+/, ""))
    .filter((day) => VALID_BY_DAYS.has(day));
}

function dayToIndex(day: string): number | null {
  const index = WEEK_DAYS.indexOf(day as (typeof WEEK_DAYS)[number]);
  return index === -1 ? null : index;
}

function startOfUtcWeek(value: Date): Date {
  const start = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  return new Date(start - value.getUTCDay() * DAY_MS);
}

function withUtcTime(day: Date, time: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), time.getUTCHours(), time.getUTCMinutes(), time.getUTCSeconds(), time.getUTCMilliseconds()));
}

function advanceDate(start: Date, recurrence: ParsedRecurrence, index: number): Date {
  const interval = index * recurrence.interval;
  switch (recurrence.frequency) {
    case "daily":
      return new Date(start.getTime() + interval * DAY_MS);
    case "weekly":
      return new Date(start.getTime() + interval * 7 * DAY_MS);
    case "monthly":
      return addUtcMonths(start, interval);
    case "yearly":
      return addUtcMonths(start, interval * 12);
  }
}

function addUtcMonths(start: Date, months: number): Date {
  const target = new Date(start.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  target.setUTCDate(Math.min(day, daysInUtcMonth(target.getUTCFullYear(), target.getUTCMonth())));
  return target;
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function compactIso(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(".000Z", "Z");
}

function parseIcsDateValue(value: string): string | undefined {
  const normalized = value.trim();
  const match = normalized.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
  if (!match) return undefined;
  const [, year, month, day, hour = "23", minute = "59", second = "59"] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))).toISOString();
}
