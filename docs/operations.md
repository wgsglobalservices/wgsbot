# Operations

Use `/api/health` and `pnpm check` for basic health checks.

Use `https://attendee.wgsglobal.app/_ops/health` for the Attendee Container router config check when deploying the optional Cloudflare Containers path.

Admins can:

- Retry bot creation.
- Fetch transcript again.
- Retry summary generation.
- Delete R2 artifacts.
- Call Attendee `delete_data` when needed.
- Review audit logs and webhook events.

Retention cleanup deletes old raw invites, transcripts, summaries, and audit logs according to settings and marks artifacts as deleted after R2 deletion.

Status meanings are intentionally explicit: invite rejection statuses identify policy failures, bot statuses mirror Attendee state, transcript statuses separate partial/complete/unavailable/failed, and summary statuses track queued/generating/ready/sent/failed.

Attendee is operationally separate from the minutesbot Worker. Cloudflare Containers can host the Attendee Docker image, but Postgres, Redis, meeting platform credentials, transcription credentials, and object storage credentials remain Attendee-owned dependencies.
