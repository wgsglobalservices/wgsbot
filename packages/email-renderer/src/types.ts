import type { MeetingRecapType, MeetingSummary } from "@minutesbot/summary-engine";
import type { RecapSectionKey } from "@minutesbot/shared";

export type SummaryEmailSummary = Omit<MeetingSummary, "meetingType"> & {
  meetingType?: MeetingRecapType;
};

export type SummaryEmailInput = {
  subject: string;
  date?: string;
  summary: SummaryEmailSummary;
  excludedRecipients?: string[];
  recap?: {
    subjectPrefix?: string;
    introText?: string;
    sections?: Array<{ key: RecapSectionKey; label: string; enabled: boolean }>;
  };
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};
