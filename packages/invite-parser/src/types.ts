import type { IcsDateTime } from "./icsDates";

export type InviteKind = "request" | "cancel" | "other";

/** A single parsed VEVENT, including recurrence fields for series masters and occurrence overrides. */
export type ParsedVEvent = {
  kind: InviteKind;
  calendarUid: string;
  subject: string;
  organizer: {
    email: string;
    name?: string;
  };
  attendees: NormalizedAttendee[];
  startTime: string;
  endTime: string;
  description?: string;
  location?: string;
  /** Structured DTSTART, keeping the wall-clock time and resolved zone. */
  startDateTime?: IcsDateTime;
  /** Structured DTEND, keeping the wall-clock time and resolved zone. */
  endDateTime?: IcsDateTime;
  /** SEQUENCE revision number; undefined when absent. */
  sequence?: number;
  /** RECURRENCE-ID of an occurrence override or per-occurrence cancellation. */
  recurrenceId?: IcsDateTime;
  /** Set when RECURRENCE-ID carries RANGE=THISANDFUTURE. */
  recurrenceRange?: "THISANDFUTURE";
  /** Raw RRULE value string, trimmed. */
  rrule?: string;
  /** RDATE additional occurrences. */
  rdates?: IcsDateTime[];
  /** EXDATE excluded occurrences. */
  exdates?: IcsDateTime[];
  /** Non-fatal parse warnings (e.g. unsupported RDATE;VALUE=PERIOD values). */
  warnings?: string[];
};

/** A whole VCALENDAR: the series master and/or occurrence overrides, in file order. */
export type ParsedCalendar = {
  /** Raw iTIP METHOD value, uppercased (e.g. "REQUEST", "CANCEL"); undefined when absent. */
  method?: string;
  kind: InviteKind;
  events: ParsedVEvent[];
};

export type ParsedMeetingInvite = ParsedVEvent & {
  /** Null only for cancellations, which are matched by calendar UID instead. */
  teamsJoinUrl: string | null;
  rawRecipient: string;
  rawSender: string;
  /** Every VEVENT in the calendar payload (master + overrides), in file order. */
  events: ParsedVEvent[];
};

export type RawIcsAttendee = {
  email: string;
  name?: string;
  role?: string;
};

export type NormalizedAttendee = {
  email: string;
  name?: string;
  role?: "required" | "optional" | "resource";
};
