# Security

## Stored Data

D1 stores settings, allowed domains, meeting metadata, attendees and eligibility flags, webhook event metadata/payloads, transcript segments, summary metadata, email delivery metadata, and audit logs. Transcript artifacts and raw invites are stored in R2, not D1.

The meeting bot runtime stores active runtime state in its container process and uploads recordings to R2. Transcript artifacts and raw invites remain outside D1.

## Secrets

Store `AI_API_KEY`, `SMTP_PASSWORD`, and `SESSION_SECRET` with `wrangler secret put`. D1 stores only configured status or secret references. The one-shot deploy flow generates and pushes the internal meeting bot token automatically.

## Inbound Email

Inbound invites are checked against the receiving MTA's `Authentication-Results` header (SPF/DKIM/DMARC alignment with the From domain) when `policy.requireAuthenticatedSender` is enabled (the default), so a spoofed internal sender cannot schedule recordings or direct recap email.

## Webhooks

Meeting bot webhooks are verified with managed internal bearer authorization. Events are deduplicated by a required `idempotency_key`, and a webhook may only mutate the meeting whose recorded bot id it carries. The bot runtime only delivers webhooks to the configured control-plane origin (`BOT_WEBHOOK_ALLOWED_ORIGINS`, derived from `BOT_WEBHOOK_BASE_URL`).

## Outbound Email

All header-bound email fields (subject, addresses, display names) are stripped of CR/LF before sending, so newline sequences in calendar content cannot inject SMTP headers. Recap test emails are restricted to the configured allowed recipient domains.

## Recipients

External attendees never receive summaries by default. The recipient policy allows exact domains by default and optional subdomain matching.

## Admin Access and Consent

Use Cloudflare Access to protect the admin UI for the MVP. The meeting bot appears as a participant. The deploying company is responsible for meeting recording/transcription consent policies and compliance.
