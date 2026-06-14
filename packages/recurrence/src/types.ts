export type IcsDateTimeLike = {
  /** ISO 8601 UTC instant, e.g. "2026-06-15T14:00:00.000Z". */
  utc: string;
  /** Local wall clock as written in ICS, "YYYY-MM-DDTHH:MM:SS". */
  wallClock?: string;
  /** Resolved IANA zone, e.g. "America/New_York". */
  timeZone?: string;
  /** True for VALUE=DATE (all-day). */
  isDate?: boolean;
};

export type RecurrenceExpansionInput = {
  /** DTSTART of the series master. */
  seriesStart: IcsDateTimeLike;
  /** DTEND - DTSTART of the master. */
  durationMs: number;
  /** Raw RRULE value, e.g. "FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=2". */
  rrule?: string;
  /** Additional explicit instances. */
  rdates?: IcsDateTimeLike[];
  /** Excluded instances. */
  exdates?: IcsDateTimeLike[];
  /** UTC ISO — only return occurrences with start >= windowStart. */
  windowStart: string;
  /** UTC ISO — only return occurrences with start < windowEnd. */
  windowEnd: string;
  /** Safety cap on returned instances, default 1000. */
  maxOccurrences?: number;
};

export type ExpandedOccurrence = {
  /** Canonical key of the ORIGINAL scheduled start, UTC basic format "YYYYMMDDTHHMMSSZ". */
  occurrenceKey: string;
  /** UTC ISO. */
  start: string;
  /** UTC ISO (start + durationMs). */
  end: string;
  isRdate?: boolean;
};
