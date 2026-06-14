// Canonical R2 key builders. Every producer and consumer goes through these
// so retention cleanup, access control, and the bot upload validator agree
// on the layout.

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label} for artifact key: ${JSON.stringify(value)}`);
  return value;
}

export function rawInviteKey(messageId: string, receivedAtIso: string): string {
  const day = receivedAtIso.slice(0, 10);
  return `raw-invites/${day}/${assertSafeId(messageId, "messageId")}.eml`;
}

export function recordingKey(occurrenceId: string, botSessionId: string, format = "mp3"): string {
  return `recordings/${assertSafeId(occurrenceId, "occurrenceId")}/${assertSafeId(botSessionId, "botSessionId")}/recording.${assertSafeId(format, "format")}`;
}

export function recordingChunkKey(occurrenceId: string, botSessionId: string, index: number, format = "mp3"): string {
  const padded = String(index).padStart(3, "0");
  return `recordings/${assertSafeId(occurrenceId, "occurrenceId")}/${assertSafeId(botSessionId, "botSessionId")}/chunks/chunk-${padded}.${assertSafeId(format, "format")}`;
}

/** Validates a recording upload target sent by the bot runtime. */
export const recordingKeyPattern = /^recordings\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/(recording|chunks\/chunk-\d{3})\.(mp3|mp4|webm|wav)$/;

export function transcriptJsonKey(occurrenceId: string): string {
  return `transcripts/${assertSafeId(occurrenceId, "occurrenceId")}/transcript.json`;
}

export function transcriptTextKey(occurrenceId: string): string {
  return `transcripts/${assertSafeId(occurrenceId, "occurrenceId")}/transcript.txt`;
}

export function recapJsonKey(occurrenceId: string): string {
  return `recaps/${assertSafeId(occurrenceId, "occurrenceId")}/recap.json`;
}

export function recapHtmlKey(occurrenceId: string): string {
  return `recaps/${assertSafeId(occurrenceId, "occurrenceId")}/recap.html`;
}

export function recapTextKey(occurrenceId: string): string {
  return `recaps/${assertSafeId(occurrenceId, "occurrenceId")}/recap.txt`;
}

export type DiagnosticFileName = "screenshot.png" | "page.html" | "console.log" | "bot.log" | "visible-text.txt" | "diagnostics.json";

export function diagnosticsKey(botSessionId: string, file: DiagnosticFileName): string {
  return `diagnostics/${assertSafeId(botSessionId, "botSessionId")}/${file}`;
}

export function botEventPayloadKey(botSessionId: string, eventId: string): string {
  return `bot-events/${assertSafeId(botSessionId, "botSessionId")}/${assertSafeId(eventId, "eventId")}.json`;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
