import { describe, expect, it } from "vitest";
import { verifySenderAuthentication } from "./senderAuthentication";

const email = (headers: string) => `${headers}\nFrom: Alice <alice@company.com>\nTo: notetaker@minutes.bot\n\nbody`;

describe("sender authentication", () => {
  it("allows messages without an Authentication-Results header but marks them unevaluated", () => {
    const result = verifySenderAuthentication(email("Subject: x"), "alice@company.com");
    expect(result.allowed).toBe(true);
    expect(result.evaluated).toBe(false);
  });

  it("allows DMARC pass", () => {
    const result = verifySenderAuthentication(
      email("Authentication-Results: mx.cloudflare.net; dkim=fail; spf=fail; dmarc=pass header.from=company.com"),
      "alice@company.com"
    );
    expect(result).toMatchObject({ allowed: true, evaluated: true });
  });

  it("allows SPF pass with an aligned mailfrom domain", () => {
    const result = verifySenderAuthentication(
      email("Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=bounce.company.com; dkim=none"),
      "alice@company.com"
    );
    expect(result).toMatchObject({ allowed: true, evaluated: true });
  });

  it("allows DKIM pass with an aligned signing domain", () => {
    const result = verifySenderAuthentication(
      email("Authentication-Results: mx.cloudflare.net; spf=fail; dkim=pass header.d=company.com"),
      "alice@company.com"
    );
    expect(result).toMatchObject({ allowed: true, evaluated: true });
  });

  it("rejects spoofed senders whose passes are not aligned with the From domain", () => {
    const result = verifySenderAuthentication(
      email("Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=attacker.net; dkim=pass header.d=attacker.net; dmarc=fail"),
      "ceo@company.com"
    );
    expect(result).toMatchObject({ allowed: false, evaluated: true });
  });

  it("rejects messages that fail all checks", () => {
    const result = verifySenderAuthentication(
      email("Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail"),
      "alice@company.com"
    );
    expect(result.allowed).toBe(false);
  });

  it("uses the topmost header so an attacker-appended forged header cannot win", () => {
    const raw = [
      "Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail",
      "Authentication-Results: forged.example; dmarc=pass",
      "From: Alice <alice@company.com>",
      "To: notetaker@minutes.bot",
      "",
      "body"
    ].join("\n");
    expect(verifySenderAuthentication(raw, "alice@company.com").allowed).toBe(false);
  });
});
