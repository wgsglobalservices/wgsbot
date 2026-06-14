# Security

## Data placement

- **D1** stores metadata only: settings, the mirrored domain allowlist, inbound message records, events/occurrences/attendees, bot sessions and webhook event metadata, transcript/recap status rows, email delivery rows, durable jobs, and audit logs.
- **R2** stores every artifact body: raw MIME invites, MP3 recordings, transcript JSON/text, recap JSON/HTML/text, bot diagnostics, and oversized webhook payloads. D1 holds only owner-scoped pointers (`artifacts` table) and hashes — never artifact bytes. Artifact content is served exclusively through the authed admin API (plus short-lived HMAC-signed download tokens embedded in recap emails); the bucket is never public.

## Secrets

Set with `wrangler secret put`, never stored in source, `.env`, or D1 (D1 keeps only "configured" status flags):

- `AI_API_KEY` — OpenAI(-compatible) key for recap generation, also used for Whisper unless `TRANSCRIPTION_API_KEY` is set.
- `TRANSCRIPTION_API_KEY` — optional separate transcription key.
- `SESSION_SECRET` — the admin token; only needed in admin-token auth mode.
- `BOT_INTERNAL_TOKEN` — generated and pushed to both workers automatically by `pnpm bot:deploy`; operators never see or handle the value.

Nothing logs secrets or tokens; runtime log tails are redacted before they appear in diagnostics.

## Admin access

Cloudflare Access is the production default; a static admin token (`SESSION_SECRET`) is the explicit development fallback. Any named environment fails closed to Access unless `ALLOW_ADMIN_TOKEN_AUTH=true` is set deliberately. Details and the public-route list: [security-access-control.md](security-access-control.md).

## Internal bot auth (signed webhooks)

`BOT_INTERNAL_TOKEN` is the single shared credential between the two workers:

- The control plane calls the bot runtime's `/v1/*` API with it as a bearer token.
- The runtime presents it back on every webhook to `/api/webhooks/bot` (bearer), and payloads are schema-validated, idempotency-keyed, and may only mutate the bot session they name.
- Recording/diagnostic uploads to `/internal/recordings` require it, are confined to the `recordings/` and `diagnostics/` key prefixes (no traversal), and are size-capped.
- The runtime only delivers webhooks to the configured control-plane origin (`BOT_WEBHOOK_ALLOWED_ORIGINS`), so the token cannot be exfiltrated via a caller-supplied webhook URL.

Comparisons are constant-time. Rotate with `pnpm bot:deploy --rotate-token`.

## Inbound email

Invites are checked against the receiving MTA's `Authentication-Results` (SPF/DKIM/DMARC alignment with the From domain) when `policy.requireAuthenticatedSender` is on (default), so a spoofed internal sender cannot schedule recordings or steer recap email. Raw messages are capped at 10 MB and deduplicated by content hash.

## Outbound email and the send boundary

- **External attendees never receive recaps.** Recipients are filtered to admin-allowed domains; the policy fields are literal types in the settings schema (`sendToAllowedDomainsOnly: true`, `sendToExternalAttendees: false`), so no settings payload can widen delivery. Skipped recipients are recorded as `skipped_policy`.
- The allowlist matches exact domains by default; subdomain matching is opt-in. Test emails are restricted to allowed domains too.
- All header-bound fields (subject, addresses, display names) are stripped of CR/LF before sending, so calendar content cannot inject SMTP headers.
- Sending goes through the Cloudflare `send_email` binding with pinned `allowed_sender_addresses`.

## Recording consent

The bot joins as a visible guest participant under a display name that must identify it as a recorder (default "Notetaker (minutesbot)"). The deploying company is responsible for meeting recording/transcription consent policies and compliance in its jurisdiction.
