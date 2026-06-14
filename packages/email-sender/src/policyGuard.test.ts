import { describe, expect, it } from "vitest";
import { createMockEmailProvider } from "./mock";
import { createPolicyEnforcedProvider } from "./policyGuard";

const message = { from: "notes@company.com", subject: "Recap", text: "body" };

describe("policy enforced provider", () => {
  it("sends to allowed domains only", async () => {
    const mock = createMockEmailProvider();
    const guarded = createPolicyEnforcedProvider(mock, { allowedDomains: ["company.com"], allowSubdomains: false });

    await expect(guarded.send({ ...message, to: "alex@company.com" })).resolves.toMatchObject({ status: "sent" });
    const blocked = await guarded.send({ ...message, to: "alex@evil.com" });
    expect(blocked.status).toBe("failed");
    expect(blocked.failureReason).toContain("blocked by policy");
    expect(mock.sent.map((m) => m.to)).toEqual(["alex@company.com"]);
  });

  it("honors the subdomain flag", async () => {
    const mock = createMockEmailProvider();
    const strict = createPolicyEnforcedProvider(mock, { allowedDomains: ["company.com"], allowSubdomains: false });
    expect((await strict.send({ ...message, to: "a@eng.company.com" })).status).toBe("failed");

    const relaxed = createPolicyEnforcedProvider(mock, { allowedDomains: ["company.com"], allowSubdomains: true });
    expect((await relaxed.send({ ...message, to: "a@eng.company.com" })).status).toBe("sent");
  });

  it("blocks malformed recipients", async () => {
    const mock = createMockEmailProvider();
    const guarded = createPolicyEnforcedProvider(mock, { allowedDomains: ["company.com"], allowSubdomains: true });
    expect((await guarded.send({ ...message, to: "not-an-email" })).status).toBe("failed");
    expect(mock.sent).toHaveLength(0);
  });
});
