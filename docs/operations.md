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

Retention cleanup deletes old raw invites, transcripts, summaries, and audit logs according to settings and marks artifacts as deleted after R2 deletion.

Status meanings are intentionally explicit: invite rejection statuses identify policy failures, bot statuses mirror meeting bot state, transcript statuses separate partial/complete/unavailable/failed, and summary statuses track queued/generating/ready/sent/failed.

The meeting bot runtime is deployed separately from the minutesbot Worker because Teams browser automation and media recording need a container runtime with Chromium and ffmpeg.
