# Access Control

Two admin auth modes, decided by wrangler vars (`apps/api-worker/src/middleware/auth.ts`):

## 1. Cloudflare Access (production default)

Put Cloudflare Access in front of the admin UI/API and let the Worker validate the Access JWT:

1. Create an Access application for the app domain (and API domain if separate).
2. Set the vars on the main worker: `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_JWKS_URL` (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), and `CLOUDFLARE_ACCESS_ISSUER`.
3. Keep `ALLOW_ADMIN_TOKEN_AUTH=false` (the checked-in default).

When the Access vars are configured, the Worker validates the `Cf-Access-Jwt-Assertion` header on every protected route (API and SPA assets) — a valid Access identity is sufficient and the static token path is skipped.

**Fail-closed rule:** any named environment (`ENVIRONMENT` set to anything other than `development`, `test`, or `local` — including typos like `prod`) without Access vars returns `503 CLOUDFLARE_ACCESS_REQUIRED` rather than silently downgrading to token auth.

## 2. Admin-token mode (development / explicit opt-in)

Set `ALLOW_ADMIN_TOKEN_AUTH=true` and a strong secret:

```bash
wrangler secret put SESSION_SECRET
```

The admin console stores the entered token in browser local storage and sends it as a bearer token; the Worker compares it to `SESSION_SECRET` in constant time. Rotate the secret if the token is ever exposed. `pnpm check` can use the same token (`MINUTESBOT_ADMIN_TOKEN`) for the authed R2 round-trip check.

## Public routes

Every `/api/*` route requires auth except:

- `/api/health`, `/api/ready` — unauthenticated health probes.
- `/api/webhooks/bot` — protected instead by the managed `BOT_INTERNAL_TOKEN` bearer (provisioned by `pnpm bot:deploy`); payloads are schema-validated, require an idempotency key, and may only mutate the session they name.
- Transcript download links in recap emails — protected by short-lived HMAC-signed download tokens.

Requests to API routes on hostnames other than the configured app domain are 404'd, and SPA assets are gated behind Access when configured.

## WAF hardening (optional)

Add WAF custom rules for common scanner paths (`/.env`, `/.git`, `/wp-admin`, `/wp-login.php`, `/phpmyadmin`, `/xmlrpc.php`) and any IP blocks your org uses. WAF is defense-in-depth, not the access-control layer.

If you enable challenges/managed rules on the bot webhook hostname, add a narrow skip rule so webhook delivery reaches the Worker instead of an HTML challenge page:

```text
http.host eq "meeting.yourcompany.com" and http.request.uri.path eq "/api/webhooks/bot" and http.request.method eq "POST"
```

Use the `skip` action for browser/security challenges on that exact POST endpoint only. This does not make the webhook unauthenticated — unauthorized POSTs still get a `401` from the Worker.
