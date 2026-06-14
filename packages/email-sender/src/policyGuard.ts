import { getEmailDomain, isAllowedDomain } from "@minutesbot/recipient-policy";
import type { EmailProvider } from "./types";

export type SendPolicy = {
  allowedDomains: string[];
  allowSubdomains: boolean;
};

/**
 * Last line of defense: wraps a provider so no message can leave to a
 * recipient outside the allowed domains, regardless of which code path
 * (retry endpoint, API bug, malformed attendee data) asked for the send.
 */
export function createPolicyEnforcedProvider(provider: EmailProvider, policy: SendPolicy): EmailProvider {
  return {
    async send(message) {
      const domain = getEmailDomain(message.to);
      if (!domain || !isAllowedDomain(domain, policy.allowedDomains, policy.allowSubdomains)) {
        return {
          status: "failed",
          failureReason: `Recipient domain ${domain ?? "(invalid)"} is not in the allowed domain list; send blocked by policy`
        };
      }
      return provider.send(message);
    }
  };
}
