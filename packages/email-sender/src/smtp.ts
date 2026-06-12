import { sanitizeEmailMessage } from "./sanitize";
import type { EmailProvider } from "./types";

export function createSmtpProvider(options: { endpoint: string; password?: string; fetcher?: typeof fetch }): EmailProvider {
  const fetcher = options.fetcher ?? fetch;
  return {
    async send(message) {
      let response: Response;
      try {
        response = await fetcher(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.password ? { authorization: `Bearer ${options.password}` } : {})
          },
          body: JSON.stringify(sanitizeEmailMessage(message)),
          signal: AbortSignal.timeout(30_000)
        });
      } catch (error) {
        return { status: "failed", failureReason: error instanceof Error ? error.message : "SMTP provider request failed" };
      }
      if (!response.ok) return { status: "failed", failureReason: `SMTP provider failed with ${response.status}` };
      return { status: "sent" };
    }
  };
}
