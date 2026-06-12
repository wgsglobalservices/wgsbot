import { describe, expect, it } from "vitest";
import {
  BOT_WEBHOOK_SECURITY_EXCEPTION_REF,
  ensureWebhookSecurityException,
  upsertWebhookSecurityException,
  webhookSecurityExceptionExpression
} from "./ensure-cloudflare-webhook-security-exception";

describe("ensureWebhookSecurityException", () => {
  it("builds the narrow meeting bot webhook POST expression", () => {
    expect(webhookSecurityExceptionExpression({ host: "meeting.minutes.bot", path: "/api/webhooks/bot" })).toBe(
      'http.host eq "meeting.minutes.bot" and http.request.uri.path eq "/api/webhooks/bot" and http.request.method eq "POST"'
    );
  });

  it("rejects webhook hosts and paths that could break out of the WAF expression", () => {
    expect(() => webhookSecurityExceptionExpression({ host: 'evil" or true', path: "/api/webhooks/bot" })).toThrow(
      'BOT_WEBHOOK_HOST "evil" or true" is invalid'
    );
    expect(() => webhookSecurityExceptionExpression({ host: "meeting.minutes.bot", path: '/api" or true' })).toThrow(
      "BOT_WEBHOOK_PATH"
    );
  });

  it("inserts the skip rule before existing custom firewall rules", () => {
    const rules = upsertWebhookSecurityException([
      {
        ref: "block_scanners",
        description: "Block scanners",
        expression: 'http.request.uri.path contains "/.env"',
        action: "block"
      }
    ]);

    expect(rules[0]).toMatchObject({
      ref: BOT_WEBHOOK_SECURITY_EXCEPTION_REF,
      expression: 'http.host eq "meeting.minutes.bot" and http.request.uri.path eq "/api/webhooks/bot" and http.request.method eq "POST"',
      action: "skip",
      action_parameters: {
        ruleset: "current",
        phases: ["http_request_firewall_managed", "http_request_sbfm"],
        products: ["bic", "securityLevel", "uaBlock", "waf"]
      },
      enabled: true
    });
    expect(rules[1].ref).toBe("block_scanners");
  });

  it("updates the zone firewall entrypoint with an idempotent webhook exception", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/zones?")) {
        return Response.json({ success: true, result: [{ id: "zone_1", name: "company.com" }] });
      }
      if (init?.method === "GET") {
        return Response.json({
          success: true,
          result: {
            name: "existing rules",
            kind: "zone",
            phase: "http_request_firewall_custom",
            rules: [
              {
                ref: "block_scanners",
                expression: 'http.request.uri.path contains "/.env"',
                action: "block"
              }
            ]
          }
        });
      }
      return Response.json({ success: true, result: {} });
    };

    await ensureWebhookSecurityException({
      apiToken: "token",
      accountId: "account_1",
      zoneName: "company.com",
      fetcher: fetcher as typeof fetch,
      log: () => undefined
    });

    const zonesRequest = requests[0];
    expect(zonesRequest?.url).toContain("account.id=account_1");
    expect(zonesRequest?.url).not.toContain("account_id=");

    const update = requests.at(-1);
    expect(update?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/rulesets/phases/http_request_firewall_custom/entrypoint");
    expect(update?.init.method).toBe("PUT");
    expect(JSON.parse(String(update?.init.body)).rules[0].ref).toBe(BOT_WEBHOOK_SECURITY_EXCEPTION_REF);
  });
});
