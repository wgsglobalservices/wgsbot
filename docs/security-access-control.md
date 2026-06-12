# Access Control

minutesbot uses layered protection on Cloudflare:

1. Cloudflare Access can protect the Worker route before traffic reaches the app.
2. The Worker validates Cloudflare Access JWTs when Access vars are configured.
3. A self-hosted admin token remains as the explicit fallback for deployments where Cloudflare Access is enforced in front of the Worker.
4. WAF rules block unwanted traffic before it reaches the Worker.

## Admin Token Setup

Set a strong `SESSION_SECRET` Cloudflare Worker secret:

```bash
wrangler secret put SESSION_SECRET
```

The admin console stores the entered token in browser local storage and sends it as a bearer token to protected API routes. Rotate `SESSION_SECRET` if the token is exposed. When Cloudflare Access validation is configured, a valid Access JWT is sufficient for protected admin UI/API routes and the admin token fallback is skipped.

The API protects every `/api/*` route except:

- `/api/health`
- `/api/webhooks/bot` (and the legacy alias `/api/webhooks/attendee`) — protected by the managed internal bot token generated during one-shot deployment; webhooks additionally require an `idempotency_key` and must match the meeting's recorded bot id
- `/api/artifacts/:meetingId/transcript.txt` — protected by a short-lived HMAC-signed download token embedded in recap emails

Any other named environment (`ENVIRONMENT` set to anything other than `development`, `test`, or `local`) requires Cloudflare Access unless `ALLOW_ADMIN_TOKEN_AUTH=true` is set explicitly; a misspelled environment name fails closed instead of silently downgrading to token auth.

## Cloudflare Access JWT Validation

The Worker can validate the `Cf-Access-Jwt-Assertion` header when deployment-specific Access JWT vars are configured. The checked-in connected-build production config does not set those vars because Access is handled outside the Worker by default; it sets `ALLOW_ADMIN_TOKEN_AUTH=true` so protected API routes continue to require the admin token instead of returning `CLOUDFLARE_ACCESS_REQUIRED`.

## Cloudflare Access and WAF

Protect the admin UI with Cloudflare Access and add WAF custom rules for common scanner paths:

- `/.env`
- `/.git`
- `/wp-admin`
- `/wp-login.php`
- `/phpmyadmin`
- `/xmlrpc.php`

In the Cloudflare dashboard, add project-level IP blocks or custom WAF rules for known unwanted sources. Do not use WAF as the only admin protection; the admin token is the access-control layer.

Add a narrow skip rule before any challenge/block rules so meeting bot webhook delivery reaches the Worker:

```text
http.host eq "meeting.minutes.bot" and http.request.uri.path eq "/api/webhooks/bot" and http.request.method eq "POST"
```

The rule should use Cloudflare's `skip` action for browser/security challenges only on that exact POST endpoint. In ruleset JSON, minutesbot applies:

```json
{
  "ref": "minutesbot_bot_webhook_security_exception",
  "action": "skip",
  "action_parameters": {
    "ruleset": "current",
    "phases": ["http_request_firewall_managed", "http_request_sbfm"],
    "products": ["bic", "securityLevel", "uaBlock", "waf"]
  }
}
```

This does not make the webhook unauthenticated. `/api/webhooks/bot` still verifies managed bearer authorization, and unauthorized POSTs should return `401 INVALID_BOT_WEBHOOK_AUTH` from the Worker instead of a Cloudflare HTML challenge page.

To apply the exception with a Cloudflare API token that can edit zone rulesets:

```bash
CLOUDFLARE_API_TOKEN=... pnpm cloudflare:ensure-webhook-bypass
```
