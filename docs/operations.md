# Operations

## Health

- `pnpm check` — API health/readiness, bot runtime health/readiness, optional authed R2 round trip. Use the same endpoints for external uptime monitoring:
  - `https://<api domain>/api/health` (expect `200 {"ok":true}`)
  - `https://<meeting-api domain>/_ops/health` (expect `200`, `ok: true`; the response carries `version` and `containerInstanceId`, which should change after every `pnpm bot:deploy`)
- `wrangler tail` (and `wrangler tail --config .wrangler/bot-container.jsonc`) streams live logs; observability is enabled in both configs.

## Admin UI tour

- **Setup** — first-run checklist and connectivity test actions (`/api/admin/test-d1`, `test-r2`, `test-bot`, `test-ai`, `test-email`). The email test only sends to the configured test recipient and is restricted to allowed domains.
- **Settings** — the full settings document (`packages/shared/src/validation.ts`): recorder address + aliases, allowed domains, bot behavior (display name, join lead, lobby wait, max duration, join attempts), transcription and recap providers/models, email sender, policy toggles, scheduling, and retention windows. Saving mirrors the domain allowlist into the `allowed_domains` table.
- **Meetings** — calendar events and their occurrences with status badges; recurring series show one row per expanded occurrence.
- **Meeting detail** — per-occurrence timeline: bot sessions and their states, attendee eligibility (who will and will not receive the recap, with exclusion reasons), transcript/recap status, email deliveries, and artifacts.
- **Bot status** — bot runtime health and active sessions.
- **Logs** — the audit log (typed events with severity, see `auditEventTypes` in `packages/shared/src/status.ts`).

## Retries

Every stage persists an explicit status, and the occurrence detail page exposes targeted retries (all also available via the API):

| Action | Endpoint | What it does |
| --- | --- | --- |
| Retry join | `POST /api/occurrences/:id/retry-join` | New `schedule_join` job + fresh bot session |
| Retry transcription | `POST /api/occurrences/:id/retry-transcription` | Re-runs Whisper on the stored recording |
| Retry recap | `POST /api/occurrences/:id/retry-recap` | Re-runs recap generation from the transcript |
| Retry delivery | `POST /api/occurrences/:id/retry-delivery` | Re-sends failed email deliveries (sent rows are not repeated) |
| Cancel bot | `POST /api/occurrences/:id/cancel-bot` | Cancels the active bot session |
| Requeue job | `POST /api/jobs/:id/requeue` | Resets a failed/dead-letter job to pending |

## Jobs and dead letters

The `jobs` table is the source of truth; the queue is a delivery hint. The per-minute cron sweeps jobs that are due, lost, or lease-expired, so a dropped queue message can delay work by at most about a minute, never lose it.

- Retryable failures back off until `max_attempts` (default 5), then become `dead_letter`; a `job.dead_letter` audit event is written.
- Queue messages that exhaust consumer retries land in the `minutesbot-dlq` queue; malformed messages are dropped with an audit log entry instead of poisoning the batch.
- Inspect with `GET /api/jobs?status=dead_letter` (or the Logs page) and recover with the requeue endpoint after fixing the root cause.

## Stale bot session recovery

If a bot container dies mid-meeting, its heartbeats stop. The per-minute cron compares `bot_sessions.last_heartbeat_at` against `scheduling.staleSessionMinutes` (default 10), double-checks the runtime, fails the session over (`bot.stale_recovered` audit event), and schedules a join retry when the meeting is still running and attempts remain. An occurrence can never hang forever on a dead container.

## Recurrence maintenance

The daily 03:00 UTC cron creates an `expand_recurrences` job that extends every active series' occurrence window to `scheduling.recurrenceExpansionDays` (default 180 days) ahead, honoring overrides and EXDATEs.

## Retention

The same daily cron creates `retention_cleanup`, which enforces the per-type windows from Settings: raw invites, recordings, transcripts, recaps/summaries, diagnostics, and audit logs each have their own day count. R2 objects are deleted first, then the artifact row is tombstoned (`deleted_at`); a `cleanup.completed` audit event summarizes each run. Admins can also delete artifacts immediately from the meeting detail page (`admin.delete` audit event).

## Audit logs

All notable transitions write typed audit events (invite received/rejected, occurrence scheduled/canceled, bot state changes, transcription/recap/email outcomes, admin actions, maintenance runs) with `info`/`warning`/`error` severity. Audit logs respect their own retention window and are the first place to look when triaging — see [troubleshooting.md](troubleshooting.md).
