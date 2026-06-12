import { createCloudflareEmailServiceProvider } from "./cloudflareEmailService";
import { createMockEmailProvider } from "./mock";
import { createSmtpProvider } from "./smtp";
import type { EmailProvider } from "./types";

export function createEmailProvider(input: {
  provider: "cloudflare-email-service" | "smtp" | "mock";
  sendEmailBinding?: { send: (message: unknown) => Promise<unknown> };
  smtpEndpoint?: string;
  smtpPassword?: string;
}): EmailProvider {
  if (input.provider === "cloudflare-email-service") {
    if (!input.sendEmailBinding) return createUnconfiguredProvider("cloudflare-email-service provider selected but no SEND_EMAIL binding is configured");
    return createCloudflareEmailServiceProvider(input.sendEmailBinding);
  }
  if (input.provider === "smtp") {
    if (!input.smtpEndpoint) return createUnconfiguredProvider("smtp provider selected but no SMTP endpoint is configured");
    return createSmtpProvider({ endpoint: input.smtpEndpoint, password: input.smtpPassword });
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
