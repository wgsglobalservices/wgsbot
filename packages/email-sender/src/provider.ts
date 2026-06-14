import { createCloudflareEmailServiceProvider } from "./cloudflareEmailService";
import { createMockEmailProvider } from "./mock";
import type { EmailProvider } from "./types";

export function createEmailProvider(input: {
  provider: "cloudflare-email-service" | "mock";
  sendEmailBinding?: { send: (message: unknown) => Promise<unknown> };
}): EmailProvider {
  if (input.provider === "cloudflare-email-service") {
    if (!input.sendEmailBinding) return createUnconfiguredProvider("cloudflare-email-service provider selected but no SEND_EMAIL binding is configured");
    return createCloudflareEmailServiceProvider(input.sendEmailBinding);
  }
  return createMockEmailProvider();
}

/**
 * A misconfigured provider must fail loudly: silently falling back to the
 * mock would record deliveries as "sent" while no email left the system.
 */
function createUnconfiguredProvider(reason: string): EmailProvider {
  return {
    async send() {
      return { status: "failed", failureReason: reason };
    }
  };
}
