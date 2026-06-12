import { parseHeaderBlock, splitMessage } from "@minutesbot/invite-parser";

export type SenderAuthenticationResult = {
  /** True when the message passed an alignment check or could not be evaluated. */
  allowed: boolean;
  /** True when an Authentication-Results header was present to evaluate. */
  evaluated: boolean;
  reason: string;
};

/**
 * Evaluates the topmost Authentication-Results header (prepended by the
 * receiving MTA — Cloudflare Email Routing in production) against the claimed
 * From domain. Forged headers further down cannot win because header parsing
 * takes the first occurrence.
 *
 * The message is allowed when DMARC passes, or when SPF/DKIM passes for a
 * domain aligned with the From domain. Messages without an
 * Authentication-Results header are allowed but flagged as unevaluated, so
 * local development and tests keep working; production traffic through
 * Cloudflare always carries the header.
 */
export function verifySenderAuthentication(rawEmail: string, fromEmail: string): SenderAuthenticationResult {
  const headers = parseHeaderBlock(splitMessage(rawEmail).headerText);
  const results = headers.get("authentication-results");
  if (!results) {
    return { allowed: true, evaluated: false, reason: "No Authentication-Results header present" };
  }

  const fromDomain = emailDomain(fromEmail);
  if (!fromDomain) {
    return { allowed: false, evaluated: true, reason: "Sender address has no domain" };
  }

  if (/\bdmarc=pass\b/i.test(results)) {
    return { allowed: true, evaluated: true, reason: "DMARC pass" };
  }

  const spfDomain = matchValue(results, /\bspf=pass\b[^;]*\bsmtp\.mailfrom=(?:[^@;\s]*@)?([^;\s]+)/i);
  if (spfDomain && domainsAligned(spfDomain, fromDomain)) {
    return { allowed: true, evaluated: true, reason: "SPF pass with aligned domain" };
  }

  const dkimDomain = matchValue(results, /\bdkim=pass\b[^;]*\bheader\.[di]=@?([^;\s]+)/i);
  if (dkimDomain && domainsAligned(dkimDomain, fromDomain)) {
    return { allowed: true, evaluated: true, reason: "DKIM pass with aligned domain" };
  }

  return { allowed: false, evaluated: true, reason: "Sender domain failed SPF/DKIM/DMARC alignment" };
}

function matchValue(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1]?.toLowerCase();
}

function emailDomain(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at === -1) return undefined;
  return email.slice(at + 1).trim().toLowerCase() || undefined;
}

/** Relaxed alignment: equal, or one is a subdomain of the other. */
function domainsAligned(authenticated: string, claimed: string): boolean {
  if (authenticated === claimed) return true;
  return authenticated.endsWith(`.${claimed}`) || claimed.endsWith(`.${authenticated}`);
}
