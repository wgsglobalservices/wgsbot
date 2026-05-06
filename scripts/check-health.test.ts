import { describe, expect, it } from "vitest";
import { checkHealth } from "./check-health";

describe("checkHealth", () => {
  it("reports Vercel deployment 404s as a DNS nameserver problem", async () => {
    const messages: string[] = [];

    const exitCode = await checkHealth({
      env: { API_BASE_URL: "https://minutesbot-api.wgsglobal.app" },
      fetchHealth: async () =>
        new Response("This deployment cannot be found", {
          status: 404,
          headers: {
            server: "Vercel",
            "x-vercel-error": "DEPLOYMENT_NOT_FOUND"
          }
        }),
      resolveNs: async () => ["ns1.vercel-dns.com", "ns2.vercel-dns.com"],
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain("404 This deployment cannot be found");
    expect(messages).toContain("wgsglobal.app is resolving through Vercel nameservers, so Cloudflare Workers cannot serve the app.");
    expect(messages).toContain("Change the registrar nameservers to abby.ns.cloudflare.com and arvind.ns.cloudflare.com, then rerun pnpm check.");
  });

  it("returns success for healthy responses", async () => {
    const messages: string[] = [];

    const exitCode = await checkHealth({
      env: { API_BASE_URL: "https://minutesbot-api.wgsglobal.app" },
      fetchHealth: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      resolveNs: async () => ["abby.ns.cloudflare.com", "arvind.ns.cloudflare.com"],
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

    expect(exitCode).toBe(0);
    expect(messages).toEqual(['200 {"ok":true}']);
  });
});
