import type { MeetingSummary } from "@minutesbot/summary-engine";
import type { RecapSectionKey } from "@minutesbot/shared";

export type SummaryEmailInput = {
  subject: string;
  date?: string;
  summary: MeetingSummary;
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
