import { describe, expect, it } from "vitest";
import { formatEmailAddress, sanitizeHeaderValue } from "./address";
import { sanitizeEmailMessage } from "./sanitize";
import { createEmailProvider } from "./provider";

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

describe("provider selection", () => {
  it("fails loudly instead of silently using the mock when misconfigured", async () => {
    const cloudflare = createEmailProvider({ provider: "cloudflare-email-service" });

    await expect(cloudflare.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" })).resolves.toMatchObject({ status: "failed" });
  });

  it("still returns the mock when explicitly requested", async () => {
    const mock = createEmailProvider({ provider: "mock" });
    await expect(mock.send({ from: "a@b.c", to: "d@e.f", subject: "S", text: "T" })).resolves.toMatchObject({ status: "sent" });
  });
});
