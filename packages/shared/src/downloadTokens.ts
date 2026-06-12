export type TranscriptDownloadTokenPayload = {
  meetingId: string;
  artifactType: "transcript_text";
  expiresAt: number;
};

export async function createTranscriptDownloadToken(payload: TranscriptDownloadTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await sign(body, secret);
  return `${body}.${signature}`;
}

export async function verifyTranscriptDownloadToken(token: string, secret: string): Promise<TranscriptDownloadTokenPayload | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = await sign(body, secret);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(body)) as Partial<TranscriptDownloadTokenPayload>;
    // Strict type checks: a malformed payload (e.g. a string expiresAt) must
    // not verify — NaN comparisons would otherwise never expire the token.
    if (parsed.artifactType !== "transcript_text") return null;
    if (typeof parsed.meetingId !== "string" || !parsed.meetingId) return null;
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return null;
    if (parsed.expiresAt < Date.now()) return null;
    return parsed as TranscriptDownloadTokenPayload;
  } catch {
    return null;
  }
}

async function sign(value: string, secret: string): Promise<string> {
  // Domain-separate the signing key from the raw secret so the admin bearer
  // secret never doubles directly as a token-signing key.
  const keyMaterial = new TextEncoder().encode(`${secret} minutesbot:transcript-download:v1`);
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

function base64UrlEncode(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
