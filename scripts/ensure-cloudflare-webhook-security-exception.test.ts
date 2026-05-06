import { describe, expect, it } from "vitest";
import {
  ATTENDEE_WEBHOOK_SECURITY_EXCEPTION_REF,
  ensureWebhookSecurityException,
  upsertWebhookSecurityException,
  webhookSecurityExceptionExpression
} from "./ensure-cloudflare-webhook-security-exception";

describe("ensureWebhookSecurityException", () => {
  it("builds the narrow Attendee webhook POST expression", () => {
    expect(webhookSecurityExceptionExpression({ host: "minutesbot.wgsglobal.app", path: "/api/webhooks/attendee" })).toBe(
      'http.host eq "minutesbot.wgsglobal.app" and http.request.uri.path eq "/api/webhooks/attendee" and http.request.method eq "POST"'
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
      ref: ATTENDEE_WEBHOOK_SECURITY_EXCEPTION_REF,
      expression: 'http.host eq "minutesbot.wgsglobal.app" and http.request.uri.path eq "/api/webhooks/attendee" and http.request.method eq "POST"',
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
        return Response.json({ success: true, result: [{ id: "zone_1", name: "wgsglobal.app" }] });
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
      zoneName: "wgsglobal.app",
      fetcher: fetcher as typeof fetch,
      log: () => undefined
    });

    const update = requests.at(-1);
    expect(update?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone_1/rulesets/phases/http_request_firewall_custom/entrypoint");
    expect(update?.init.method).toBe("PUT");
    expect(JSON.parse(String(update?.init.body)).rules[0].ref).toBe(ATTENDEE_WEBHOOK_SECURITY_EXCEPTION_REF);
  });
});
