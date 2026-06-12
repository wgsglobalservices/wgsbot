import { stableStringify } from "@minutesbot/shared";

export type VerifyWebhookSignatureInput = {
  rawBody: string;
  webhookSecretBase64: string;
  signature: string | null;
};

export async function verifyBotWebhookSignature(input: VerifyWebhookSignatureInput): Promise<boolean> {
  if (!input.signature) return false;
  let canonical: string;
  try {
    canonical = stableStringify(JSON.parse(input.rawBody));
  } catch {
    return false;
  }

  const secret = base64ToArrayBuffer(input.webhookSecretBase64);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  const actual = bytesToBase64(digest);
  return timingSafeEqual(actual, input.signature);
}

export { verifyBotWebhookSignature as verifyAttendeeWebhookSignature };

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
