import { sanitizeEmailMessage } from "./sanitize";
import type { EmailMessage, EmailProvider } from "./types";

export function createCloudflareEmailServiceProvider(binding: { send: (message: unknown) => Promise<unknown> }): EmailProvider {
  return {
    async send(message: EmailMessage) {
      try {
        const result = await binding.send(sanitizeEmailMessage(message));
        return { status: "sent" as const, providerMessageId: extractMessageId(result) };
      } catch (error) {
        return { status: "failed" as const, failureReason: error instanceof Error ? error.message : "Email binding send failed" };
      }
    }
  };
}

function extractMessageId(result: unknown): string | undefined {
  if (typeof result === "object" && result && "id" in result) return String((result as { id: unknown }).id);
  return undefined;
}
