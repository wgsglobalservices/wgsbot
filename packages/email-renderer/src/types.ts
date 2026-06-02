import type { MeetingRecapType, MeetingSummary, RecapDepth } from "@minutesbot/summary-engine";
import type { RecapSectionKey } from "@minutesbot/shared";

export type SummaryEmailSummary = Partial<Pick<MeetingSummary, "executiveRecap" | "meetingNotes" | "followUpTasks">> &
  Omit<MeetingSummary, "meetingType" | "recapDepth" | "executiveRecap" | "meetingNotes" | "followUpTasks"> & {
  meetingType?: MeetingRecapType;
  recapDepth?: RecapDepth;
};

export type SummaryEmailInput = {
  subject: string;
  date?: string;
  summary: SummaryEmailSummary;
  transcriptDownloadUrl?: string;
  transcriptDownloadExpirationHours?: number;
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
