export type InviteKind = "request" | "cancel";

export type ParsedMeetingInvite = {
  kind: InviteKind;
  calendarUid: string;
  subject: string;
  organizer: {
    email: string;
    name?: string;
  };
  attendees: Array<{
    email: string;
    name?: string;
    role?: "required" | "optional" | "resource";
  }>;
  startTime: string;
  endTime: string;
  teamsJoinUrl: string;
  rawRecipient: string;
  rawSender: string;
  recurrence?: ParsedRecurrence;
};

export type ParsedCalendar = Omit<ParsedMeetingInvite, "rawRecipient" | "rawSender" | "teamsJoinUrl"> & {
  description?: string;
  location?: string;
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

export type ParsedRecurrence = {
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  count?: number;
  until?: string;
  byDay?: string[];
};

export type MeetingOccurrence = {
  calendarUid: string;
  seriesUid: string;
  startTime: string;
  endTime: string;
  occurrenceIndex: number;
  recurring: boolean;
};
