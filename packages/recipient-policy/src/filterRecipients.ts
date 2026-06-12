import { getEmailDomain, isAllowedDomain } from "./allowedDomains";
import type { ExcludedRecipient, Recipient, RecipientPolicy } from "./types";

export type SummaryRecipientInput = {
  organizer?: Recipient | null;
  attendees: Recipient[];
  primaryDomain: string;
  allowedDomains: string[];
  allowSubdomains: boolean;
};

export function buildSummaryRecipients(input: SummaryRecipientInput): { included: Recipient[]; excluded: ExcludedRecipient[] } {
  const recipients = dedupeRecipients([...(input.organizer ? [input.organizer] : []), ...input.attendees]);
  return filterSummaryRecipients(recipients, {
    allowedDomains: Array.from(new Set([input.primaryDomain, ...input.allowedDomains].map((domain) => domain.trim().toLowerCase()).filter(Boolean))),
    allowSubdomains: input.allowSubdomains,
    sendToExternalAttendees: false
  });
}

export function filterSummaryRecipients(
  attendees: Recipient[],
  policy: RecipientPolicy
): { included: Recipient[]; excluded: ExcludedRecipient[] } {
  const included: Recipient[] = [];
  const excluded: ExcludedRecipient[] = [];

  for (const attendee of attendees) {
    const email = attendee.email.trim().toLowerCase();
    const domain = getEmailDomain(email);
    if (!domain) {
      excluded.push({ ...attendee, email, reason: "excluded_invalid_email" });
      continue;
    }
    if (!isAllowedDomain(domain, policy.allowedDomains, policy.allowSubdomains)) {
      excluded.push({ ...attendee, email, domain, reason: "excluded_external_domain" });
      continue;
    }
    included.push({ ...attendee, email, domain });
  }

  return { included, excluded };
}

function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const deduped: Recipient[] = [];
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    deduped.push({ ...recipient, email });
  }
  return deduped;
}
