import { describe, expect, it, vi } from "vitest";
import { formatEmailAddress, sanitizeHeaderValue } from "./address";
import { sanitizeEmailMessage } from "./sanitize";
import { createEmailProvider } from "./provider";
import { createSmtpProvider } from "./smtp";

describe("header sanitization", () => {
  it("strips CR/LF/NUL from header-bound values", () => {
    expect(sanitizeHeaderValue("Hello\r\nBcc: evil@x.com")).toBe("Hello Bcc: evil@x.com");
    expect(sanitizeHeaderValue("Plain")).toBe("Plain");
  });

  it("neutralizes newline injection in subjects from ICS content", () => {
    const message = sanitizeEmailMessage({
      from: "notes@company.com",
      to: "user@company.com",
      subject: "Meeting recap: Hello\nX-Injected: 1",
      text: "body\nwith newlines kept"
    });

    expect(message.subject).toBe("Meeting recap: Hello X-Injected: 1");
    expect(message.text).toBe("body\nwith newlines kept");
  });

  it("quotes display names containing address specials", () => {
    expect(formatEmailAddress("Smith, John", "john@company.com")).toBe('"Smith, John" <john@company.com>');
    expect(formatEmailAddress("Plain Name", "a@b.com")).toBe("Plain Name <a@b.com>");
    expect(formatEmailAddress("Evil\r\nBcc: x@y.z", "a@b.com")).toBe('"Evil Bcc: x@y.z" <a@b.com>');
  });
});

describe("smtp provider", () => {
  it("sends the configured password as the bearer credential", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const provider = createSmtpProvider({ endpoint: "https://bridge.example.com/send", password: "real-password", fetcher: fetcher as unknown as typeof fetch });

    await provider.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" });

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer real-password");
  });

  it("maps network failures to a failed result instead of throwing", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connect timeout");
    });
    const provider = createSmtpProvider({ endpoint: "https://bridge.example.com/send", fetcher: fetcher as unknown as typeof fetch });

    await expect(provider.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" })).resolves.toEqual({
      status: "failed",
      failureReason: "connect timeout"
    });
  });
});

describe("provider selection", () => {
  it("fails loudly instead of silently using the mock when misconfigured", async () => {
    const cloudflare = createEmailProvider({ provider: "cloudflare-email-service" });
    const smtp = createEmailProvider({ provider: "smtp" });

    await expect(cloudflare.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" })).resolves.toMatchObject({ status: "failed" });
    await expect(smtp.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" })).resolves.toMatchObject({ status: "failed" });
  });

  it("still returns the mock when explicitly requested", async () => {
    const mock = createEmailProvider({ provider: "mock" });
    await expect(mock.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" })).resolves.toMatchObject({ status: "sent" });
  });
});
