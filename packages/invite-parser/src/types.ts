export type InviteKind = "request" | "cancel" | "other";

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
  /** Null only for cancellations, which are matched by calendar UID instead. */
  teamsJoinUrl: string | null;
  rawRecipient: string;
  rawSender: string;
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
