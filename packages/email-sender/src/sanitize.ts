import { sanitizeHeaderValue } from "./address";
import type { EmailMessage } from "./types";

/** Sanitizes every header-bound field of an outbound message. */
export function sanitizeEmailMessage(message: EmailMessage): EmailMessage {
  return {
    ...message,
    from: sanitizeHeaderValue(message.from),
    to: sanitizeHeaderValue(message.to),
    subject: sanitizeHeaderValue(message.subject)
  };
}
