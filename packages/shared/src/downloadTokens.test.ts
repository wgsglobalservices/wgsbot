import { describe, expect, it } from "vitest";
import { createTranscriptDownloadToken, verifyTranscriptDownloadToken } from "./downloadTokens";

const secret = "test-session-secret";

function encodePayload(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

describe("transcript download tokens", () => {
  it("round-trips a valid token", async () => {
    const payload = { occurrenceId: "occ_1", artifactType: "transcript_text" as const, expiresAt: Date.now() + 60_000 };
    const token = await createTranscriptDownloadToken(payload, secret);

    await expect(verifyTranscriptDownloadToken(token, secret)).resolves.toEqual(payload);
  });

  it("rejects expired tokens", async () => {
    const token = await createTranscriptDownloadToken(
      { occurrenceId: "occ_1", artifactType: "transcript_text", expiresAt: Date.now() - 1_000 },
      secret
    );

    await expect(verifyTranscriptDownloadToken(token, secret)).resolves.toBeNull();
  });

  it("rejects tampered payloads", async () => {
    const token = await createTranscriptDownloadToken(
      { occurrenceId: "occ_1", artifactType: "transcript_text", expiresAt: Date.now() + 60_000 },
      secret
    );
    const [, signature] = token.split(".");
    const forgedBody = encodePayload({ occurrenceId: "occ_2", artifactType: "transcript_text", expiresAt: Date.now() + 60_000 });

    await expect(verifyTranscriptDownloadToken(`${forgedBody}.${signature}`, secret)).resolves.toBeNull();
  });

  it("rejects tokens signed with a different secret", async () => {
    const token = await createTranscriptDownloadToken(
      { occurrenceId: "occ_1", artifactType: "transcript_text", expiresAt: Date.now() + 60_000 },
      "other-secret"
    );

    await expect(verifyTranscriptDownloadToken(token, secret)).resolves.toBeNull();
  });

  it("rejects type-confused payloads whose expiresAt is not a finite number", async () => {
    // A string expiresAt previously verified forever: !"not-a-number" is
    // false and NaN comparisons never expire.
    for (const expiresAt of ["not-a-number", null, Number.POSITIVE_INFINITY]) {
      const forged = { occurrenceId: "occ_1", artifactType: "transcript_text", expiresAt };
      const body = encodePayload(forged);
      const reference = await createTranscriptDownloadToken(
        { occurrenceId: "occ_1", artifactType: "transcript_text", expiresAt: Date.now() + 60_000 },
        secret
      );
      void reference;
      // Sign the forged body with the real signer to isolate the payload validation.
      const signed = await createTranscriptDownloadToken(forged as never, secret);
      expect(signed.startsWith(body)).toBe(true);
      await expect(verifyTranscriptDownloadToken(signed, secret)).resolves.toBeNull();
    }
  });

  it("rejects malformed tokens", async () => {
    await expect(verifyTranscriptDownloadToken("garbage", secret)).resolves.toBeNull();
    await expect(verifyTranscriptDownloadToken("a.b", secret)).resolves.toBeNull();
    await expect(verifyTranscriptDownloadToken("", secret)).resolves.toBeNull();
  });
});
