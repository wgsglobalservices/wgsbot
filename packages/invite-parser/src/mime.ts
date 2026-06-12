const MAX_MULTIPART_DEPTH = 5;

export type MimePart = {
  headers: Map<string, string>;
  body: string;
};

/** Splits a raw RFC 822 message into its header block and body. */
export function splitMessage(raw: string): { headerText: string; body: string } {
  const separator = raw.match(/\r?\n\r?\n/);
  if (!separator || separator.index === undefined) return { headerText: raw, body: "" };
  return { headerText: raw.slice(0, separator.index), body: raw.slice(separator.index + separator[0].length) };
}

/**
 * Parses an unfolded header block into a name -> value map. When a header
 * appears multiple times the first (topmost) occurrence wins, matching how
 * trusted trace headers are prepended by the receiving MTA.
 */
export function parseHeaderBlock(headerText: string): Map<string, string> {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(index + 1).trim());
  }
  return headers;
}

/** Reads a single parameter (e.g. boundary, charset) from a structured header value. */
export function headerParam(headerValue: string | undefined, param: string): string | undefined {
  if (!headerValue) return undefined;
  const match = headerValue.match(new RegExp(`${param}\\s*=\\s*("[^"]*"|[^;\\s]+)`, "i"));
  return match?.[1]?.replace(/^"|"$/g, "");
}

/**
 * Finds the decoded text/calendar part of a message. Handles nested
 * multipart containers and base64/quoted-printable transfer encodings.
 * Falls back to scanning the raw message for a bare VCALENDAR block.
 */
export function extractCalendarText(rawEmail: string): string | null {
  const { headerText, body } = splitMessage(rawEmail);
  const root: MimePart = { headers: parseHeaderBlock(headerText), body };
  const part = findPartByType(root, "text/calendar", 0);
  if (part) {
    const calendar = sliceCalendarBlock(decodePartBody(part));
    if (calendar) return calendar;
  }
  return sliceCalendarBlock(rawEmail);
}

/**
 * Returns the decoded textual content of a message: every text/* part of a
 * multipart message concatenated, or the decoded body of a simple message.
 */
export function extractTextBody(rawEmail: string): string {
  const { headerText, body } = splitMessage(rawEmail);
  const root: MimePart = { headers: parseHeaderBlock(headerText), body };
  const contentType = (root.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("multipart/")) return decodePartBody(root);
  const textParts: string[] = [];
  collectTextParts(root, 0, textParts);
  return textParts.length > 0 ? textParts.join("\n") : body;
}

function collectTextParts(part: MimePart, depth: number, into: string[]): void {
  const contentType = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  if (contentType.startsWith("multipart/")) {
    if (depth >= MAX_MULTIPART_DEPTH) return;
    for (const child of childParts(part)) collectTextParts(child, depth + 1, into);
    return;
  }
  if (contentType.startsWith("text/") && !contentType.startsWith("text/calendar")) {
    into.push(decodePartBody(part));
  }
}

function findPartByType(part: MimePart, type: string, depth: number): MimePart | null {
  const contentType = (part.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith(type)) return part;
  if (!contentType.startsWith("multipart/") || depth >= MAX_MULTIPART_DEPTH) return null;
  for (const child of childParts(part)) {
    const found = findPartByType(child, type, depth + 1);
    if (found) return found;
  }
  return null;
}

function childParts(part: MimePart): MimePart[] {
  const boundary = headerParam(part.headers.get("content-type"), "boundary");
  if (!boundary) return [];
  return splitMultipart(part.body, boundary).map((segment) => {
    const { headerText, body } = splitMessage(segment);
    return { headers: parseHeaderBlock(headerText), body };
  });
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const closing = `${delimiter}--`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === delimiter || trimmed === closing) {
      if (current) parts.push(current.join("\n"));
      current = trimmed === delimiter ? [] : null;
      if (trimmed === closing) break;
    } else if (current) {
      current.push(line);
    }
  }
  return parts;
}

function decodePartBody(part: MimePart): string {
  const charset = headerParam(part.headers.get("content-type"), "charset") ?? "utf-8";
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  if (encoding === "base64") return decodeBase64Text(part.body, charset);
  if (encoding === "quoted-printable") return decodeQuotedPrintable(part.body, charset);
  return part.body;
}

export function decodeBase64Text(input: string, charset = "utf-8"): string {
  const compact = input.replace(/[^A-Za-z0-9+/=]/g, "");
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return decodeBytes(bytes, charset);
  } catch {
    return input;
  }
}

export function decodeQuotedPrintable(input: string, charset = "utf-8"): string {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < withoutSoftBreaks.length; index += 1) {
    const char = withoutSoftBreaks[index];
    if (char === "=" && /^[0-9a-f]{2}$/i.test(withoutSoftBreaks.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(withoutSoftBreaks.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      const code = withoutSoftBreaks.charCodeAt(index);
      // Mislabelled 8-bit content: keep multi-byte characters intact by
      // re-encoding them rather than truncating to a single byte.
      if (code > 0xff) {
        for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
      } else {
        bytes.push(code);
      }
    }
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

/** Decodes RFC 2047 encoded words (both B and Q encodings, charset-aware). */
export function decodeMimeWords(value: string): string {
  // Whitespace between adjacent encoded words is not significant (RFC 2047 §6.2).
  const joined = value.replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?)/gi, "$1");
  return joined.replace(/=\?([^?\s]+)\?([bq])\?([^?\s]*)\?=/gi, (match, charset: string, encoding: string, text: string) => {
    try {
      if (encoding.toLowerCase() === "b") return decodeBase64Text(text, charset);
      return decodeQuotedPrintable(text.replace(/_/g, " "), charset);
    } catch {
      return match;
    }
  });
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const normalized = charset.trim().toLowerCase().replace(/^"|"$/g, "") || "utf-8";
  try {
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function sliceCalendarBlock(text: string): string | null {
  const begin = text.indexOf("BEGIN:VCALENDAR");
  if (begin === -1) return null;
  const end = text.indexOf("END:VCALENDAR", begin);
  if (end === -1) return null;
  return text.slice(begin, end + "END:VCALENDAR".length);
}
