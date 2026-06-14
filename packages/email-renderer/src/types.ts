import type { RecapDocument } from "@minutesbot/summary-engine";

export type RecapEmailInput = {
  subject: string;
  /** ISO start of the occurrence, rendered in timeZone. */
  startTime?: string;
  /** IANA time zone for rendering meeting times; defaults to UTC. */
  timeZone?: string;
  recap: RecapDocument;
  subjectPrefix?: string;
  introText?: string;
  /** Attendees excluded from delivery by policy, shown for transparency. */
  excludedRecipients?: string[];
  /** Access-controlled admin link to the occurrence; never a raw artifact URL. */
  adminUrl?: string;
};

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};
