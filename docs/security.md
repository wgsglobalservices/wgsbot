# Security

## Stored Data

D1 stores settings, allowed domains, meeting metadata, attendees and eligibility flags, webhook event metadata/payloads, transcript segments, summary metadata, email delivery metadata, and audit logs. Transcript artifacts and raw invites are stored in R2, not D1.

Attendee stores meeting data separately in the company's self-hosted Attendee instance.

## Secrets

Store `ATTENDEE_API_KEY`, `ATTENDEE_WEBHOOK_SECRET`, `AI_API_KEY`, `EMAIL_API_KEY`, `SMTP_PASSWORD`, `SESSION_SECRET`, and `TRANSCRIPT_LINK_SECRET` with `wrangler secret put`. D1 stores only configured status or secret references. Use a separate `TRANSCRIPT_LINK_SECRET`; do not reuse the admin session token for emailed transcript download links.

## Webhooks

Attendee webhooks fail closed unless `ATTENDEE_WEBHOOK_SECRET` is configured. Requests are verified with HMAC-SHA256 using canonicalized JSON and `X-Webhook-Signature`, and webhook payloads must include an `idempotency_key` for replay protection.

## Provider URLs

Admin-configured Attendee and AI base URLs are allowlisted before secrets are sent upstream. Add `ATTENDEE_BASE_URL_ALLOWLIST` or `AI_BASE_URL_ALLOWLIST` as comma-separated HTTPS origins only when a self-hosted provider is intentionally approved.

## Recipients

External attendees never receive summaries by default. The recipient policy allows exact domains by default and optional subdomain matching.

## Admin Access and Consent

Use Cloudflare Access to protect the admin UI for the MVP. The meeting bot appears as a participant. The deploying company is responsible for meeting recording/transcription consent policies and compliance.
