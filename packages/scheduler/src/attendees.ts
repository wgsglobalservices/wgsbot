import type { AttendeeInput } from "@minutesbot/db";
import type { NormalizedAttendee } from "@minutesbot/invite-parser";
import { getEmailDomain, isAllowedDomain } from "@minutesbot/recipient-policy";
import type { AppSettings } from "@minutesbot/shared";

export type AttendeeSource = {
  organizer?: { email: string; name?: string } | null;
  attendees: NormalizedAttendee[];
};

/**
 * Computes the stored attendee rows for an event/occurrence: recipient
 * eligibility is decided once at ingestion (and re-checked at the send
 * boundary). The recorder mailbox itself is never an attendee.
 */
export function computeAttendeeRows(source: AttendeeSource, settings: AppSettings): AttendeeInput[] {
  const recorderEmails = new Set([settings.recorderEmail, ...settings.recorderAliasEmails].map((email) => email.toLowerCase()));
  const seen = new Set<string>();
  const rows: AttendeeInput[] = [];
  const candidates: Array<{ email: string; name?: string; role?: string }> = [
    ...(source.organizer?.email ? [{ email: source.organizer.email, name: source.organizer.name, role: "organizer" }] : []),
    ...source.attendees
  ];
  for (const candidate of candidates) {
    const email = candidate.email.trim().toLowerCase();
    if (!email || recorderEmails.has(email) || seen.has(email)) continue;
    seen.add(email);
    const domain = getEmailDomain(email);
    if (!domain) {
      rows.push({
        email,
        name: candidate.name ?? null,
        role: candidate.role ?? null,
        domain: null,
        isExternal: true,
        recipientEligible: false,
        exclusionReason: "excluded_invalid_email"
      });
      continue;
    }
    const allowed = isAllowedDomain(domain, settings.allowedDomains, settings.policy.allowSubdomains);
    const organizerOnly = settings.policy.distribution === "organizer_only" && candidate.role !== "organizer";
    rows.push({
      email,
      name: candidate.name ?? null,
      role: candidate.role ?? null,
      domain,
      isExternal: !allowed,
      recipientEligible: allowed && !organizerOnly,
      exclusionReason: !allowed ? "excluded_external_domain" : organizerOnly ? "excluded_distribution_policy" : null
    });
  }
  return rows;
}
