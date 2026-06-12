# Operations

Use `/api/health` and `pnpm check` for basic health checks.

Use `https://meeting-api.minutes.bot/_ops/health` for the meeting bot container runtime check.

Admins can:

- Retry bot creation.
- Fetch transcript again.
- Retry summary generation.
- Delete R2 artifacts.
- Delete meeting bot runtime data when needed.
- Review audit logs and webhook events.

Retention cleanup runs on the Worker cron trigger (daily at 03:00 UTC, configured in `wrangler.jsonc`) and deletes old raw invites, recordings, transcripts, transcript segments, summaries, and audit logs according to settings, marking artifacts as deleted after R2 deletion.

Queue consumers retry failed messages with a delay and route messages that exhaust retries to the `minutesbot-dlq` dead-letter queue; malformed messages are dropped with an audit log entry instead of poisoning the batch.

Status meanings are intentionally explicit: invite rejection statuses identify policy failures, bot statuses mirror meeting bot state, transcript statuses separate partial/complete/unavailable/failed, and summary statuses track queued/generating/ready/sent/failed.

The meeting bot runtime is deployed separately from the minutesbot Worker because Teams browser automation and media recording need a container runtime with Chromium and ffmpeg.
