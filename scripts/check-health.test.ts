import { describe, expect, it } from "vitest";
import { checkHealth } from "./check-health";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function fetchStub(handler: (url: string, init?: FetchInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit) => handler(String(input), init)) as typeof fetch;
}

const healthyEnv = {
  API_BASE_URL: "https://api.minutes.bot",
  BOT_API_BASE_URL: "https://meeting-api.minutes.bot"
};

describe("checkHealth", () => {
  it("passes when API and bot runtime endpoints are healthy", async () => {
    const messages: string[] = [];
    const requested: string[] = [];

    const exitCode = await checkHealth({
      env: healthyEnv,
      fetchHealth: fetchStub((url) => {
        requested.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
      resolveNs: async () => [],
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

    expect(exitCode).toBe(0);
    expect(requested).toEqual([
      "https://api.minutes.bot/api/health",
      "https://api.minutes.bot/api/ready",
      "https://meeting-api.minutes.bot/_ops/health",
      "https://meeting-api.minutes.bot/_ops/ready"
    ]);
    expect(messages.filter((m) => m.startsWith("PASS"))).toHaveLength(4);
    // The R2 round trip is skipped without an admin token.
    expect(messages.some((m) => m.startsWith("SKIP") && m.includes("test-r2"))).toBe(true);
    expect(messages).toContain("All health checks passed.");
  });

  it("runs the authed R2 round trip when MINUTESBOT_ADMIN_TOKEN is set", async () => {
    const authHeaders: Array<string | undefined> = [];

    const exitCode = await checkHealth({
      env: { ...healthyEnv, MINUTESBOT_ADMIN_TOKEN: "admin-token" },
      fetchHealth: fetchStub((url, init) => {
        if (url.endsWith("/api/admin/test-r2")) {
          authHeaders.push((init?.headers as Record<string, string> | undefined)?.authorization);
          expect(init?.method).toBe("POST");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
      resolveNs: async () => [],
      log: () => undefined,
      error: () => undefined
    });

    expect(exitCode).toBe(0);
    expect(authHeaders).toEqual(["Bearer admin-token"]);
  });

  it("fails with exit code 1 when any endpoint is unhealthy", async () => {
    const messages: string[] = [];

    const exitCode = await checkHealth({
      env: healthyEnv,
      fetchHealth: fetchStub((url) =>
        url.endsWith("/_ops/ready")
          ? new Response(JSON.stringify({ ready: false, reason: "at capacity" }), { status: 503 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 })
      ),
      resolveNs: async () => [],
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

    expect(exitCode).toBe(1);
    expect(messages.some((m) => m.startsWith("FAIL") && m.includes("/_ops/ready") && m.includes("503"))).toBe(true);
    expect(messages).toContain("1 health check(s) failed.");
  });

  it("reports Vercel deployment 404s as a DNS nameserver problem", async () => {
    const messages: string[] = [];

    const exitCode = await checkHealth({
      env: { API_BASE_URL: "https://api.minutes.bot" },
      fetchHealth: fetchStub(
        () =>
          new Response("This deployment cannot be found", {
            status: 404,
            headers: {
              server: "Vercel",
              "x-vercel-error": "DEPLOYMENT_NOT_FOUND"
            }
          })
      ),
      resolveNs: async () => ["ns1.vercel-dns.com", "ns2.vercel-dns.com"],
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

    expect(exitCode).toBe(1);
    expect(messages).toContain("minutes.bot is resolving through Vercel nameservers, so Cloudflare Workers cannot serve the app.");
    expect(messages).toContain(
      "Change the registrar nameservers to the Cloudflare nameservers assigned to your zone — see the Cloudflare dashboard, then rerun pnpm check."
    );
  });

  it("accepts any Cloudflare-assigned nameservers without blaming DNS", async () => {
    const messages: string[] = [];

    const exitCode = await checkHealth({
      env: { API_BASE_URL: "https://api.minutes.bot" },
      fetchHealth: fetchStub(
        () =>
          new Response("This deployment cannot be found", {
            status: 404,
            headers: {
              server: "Vercel",
              "x-vercel-error": "DEPLOYMENT_NOT_FOUND"
            }
          })
      ),
      resolveNs: async () => ["kiki.ns.cloudflare.com", "carl.ns.cloudflare.com"],
      log: (message) => messages.push(message),
      error: (message) => messages.push(message)
    });

    expect(exitCode).toBe(1);
    expect(messages.some((m) => m.includes("resolving through Vercel nameservers"))).toBe(false);
  });

  it("falls back to wrangler.jsonc vars and skips bot checks for placeholder domains", async () => {
    const requested: string[] = [];

    await checkHealth({
      env: {},
      readConfig: async () =>
        JSON.stringify({
          vars: { API_BASE_URL: "https://api.minutes.bot", BOT_API_BASE_URL: "https://meeting-api.example.com" }
        }),
      fetchHealth: fetchStub((url) => {
        requested.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
      resolveNs: async () => [],
      log: () => undefined,
      error: () => undefined
    });

    expect(requested).toEqual(["https://api.minutes.bot/api/health", "https://api.minutes.bot/api/ready"]);
  });
});
