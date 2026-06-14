# Meeting Bot Runtime

minutesbot ships its own first-party Teams meeting bot. Three pieces:

- `apps/bot-runtime` — Node/TypeScript Hono service inside the container: drives a Playwright Chromium guest join into Teams, captures meeting audio via a PulseAudio monitor + ffmpeg into MP3, uploads recordings, and emits webhooks.
- `deploy/bot-container` — the `minutesbot-meeting-bot` Cloudflare Worker hosting the `MeetingBotContainer` class (Cloudflare Containers) plus the `PUT /internal/recordings` endpoint that streams uploads into the `minutesbot-artifacts` R2 bucket (token-authenticated, key-prefix-confined, 200 MB cap).
- `packages/bot-client` — the typed fetch client and webhook payload schema the control plane uses (`packages/bot-client/src/types.ts` is the contract).

Deploy with `pnpm bot:deploy` — see [deployment.md](deployment.md). The script regenerates `BOT_CONTAINER_INSTANCE_ID` each deploy so Containers do not keep routing to an old sleeping instance, stamps `BOT_RUNTIME_VERSION` from git, and provisions the shared `BOT_INTERNAL_TOKEN` secret on both workers.

## Runtime API

All `/v1/*` routes require `Authorization: Bearer <BOT_INTERNAL_TOKEN>`. The ops routes are unauthenticated.

| Route | Purpose |
| --- | --- |
| `GET /_ops/health` | `{ ok, version, containerInstanceId, checks: { chromium, ffmpeg, pulseaudio, tempWritable, config } }`; 503 when any check fails |
| `GET /_ops/ready` | `{ ready }` or `{ ready: false, reason }` (unhealthy, or at session capacity); 503 when not ready |
| `POST /v1/bots` | Create a bot session. Body mirrors `CreateBotRuntimeInput`: `botSessionId`, `occurrenceId`, `meetingUrl` (must be a Teams join URL; 422 otherwise), `displayName`, `joinTimeoutSeconds`, `maxDurationSeconds`, `recording: { format: "mp3" }`, `webhook: { url, token }`, `upload: { url, token, recordingKey, chunkKeyPrefix?, chunkThresholdBytes? }`. Returns `{ runtimeBotId, state: "created" }` |
| `GET /v1/bots/:runtimeBotId` | `RuntimeBotStatus`: state, timestamps, `lastHeartbeatAt`, `failureStage`/`failureReason` |
| `POST /v1/bots/:runtimeBotId/cancel` | Cancel the session; returns the resulting state |
| `GET /v1/bots/:runtimeBotId/diagnostics` | `BotRuntimeDiagnostics`: state history, redacted log tail, storage keys of uploaded diagnostics |

## State machine

```text
created -> warming -> browser_starting -> prejoin
  -> waiting_for_start | waiting_room -> joined -> recording
  -> stopping -> uploading -> post_processing_completed
any state -> failed | canceled
```

On failure the runtime sets a `failureStage` (one of `sign_in_required`, `captcha`, `admission_denied`, `meeting_ended`, `invalid_meeting_url`, `policy_blocked`, `browser_launch`, `navigation`, `page_load`, `lobby_timeout`, `meeting_not_started_timeout`, `audio_setup`, `recording`, `upload`, `internal`) and uploads diagnostics (screenshot, page HTML, visible text, console log) before reporting.

## Webhooks

The runtime POSTs to the configured webhook URL (the control plane's `/api/webhooks/bot`) with `Authorization: Bearer <token from the create call>`. Webhook targets are restricted to the configured control-plane origin (`BOT_WEBHOOK_ALLOWED_ORIGINS`, derived from `BOT_WEBHOOK_BASE_URL`), so a caller cannot exfiltrate the token to an arbitrary URL.

Payload (validated against `botWebhookPayloadSchema` before the control plane trusts any field):

```json
{
  "idempotencyKey": "<botSessionId>:<eventType>:<state>:<monotonicSeq>",
  "botSessionId": "…",
  "runtimeBotId": "…",
  "eventType": "state_change | heartbeat | log",
  "state": "recording",
  "failureStage": "lobby_timeout",
  "failureReason": "…",
  "recordingKey": "recordings/…/recording.mp3",
  "recordingChunkKeys": ["…"],
  "diagnosticsKeys": ["diagnostics/…/screenshot.png"],
  "timestamp": "2026-06-12T10:00:00.000Z"
}
```

Events are idempotent (`idempotencyKey` is unique in `bot_events`); duplicates are acknowledged and ignored. Heartbeats refresh `bot_sessions.last_heartbeat_at`, which drives stale-session recovery.

## Recording upload

The runtime PUTs the MP3 to the bot worker's own `/internal/recordings` endpoint with the internal token, `x-recording-bucket`, and `x-recording-key` headers; the worker streams it into R2. Long meetings can upload chunks under `chunkKeyPrefix` when they cross `chunkThresholdBytes`. The control plane then runs the transcribe job against the R2 object.

## Live test against a real Teams tenant

After deploying both workers (`pnpm deploy`, `pnpm bot:deploy`, `pnpm check` green):

1. **Schedule** a Teams meeting in Outlook/Teams a few minutes out and invite the recorder mailbox (e.g. `notetaker@yourcompany.com`) plus at least one attendee on an allowed domain.
2. **Watch ingestion** — the meeting appears on the admin Meetings page within seconds (audit: `invite.received`, `occurrence.scheduled`). If not, see "Invite ingestion" in [troubleshooting.md](troubleshooting.md).
3. **Watch the join** — at `start - bot.joinLeadMinutes` the occurrence goes `join_queued`; the bot session walks `created → … → prejoin → waiting_room`. Admit "Notetaker (minutesbot)" from the lobby if your policy requires it; the session moves to `joined → recording` and the occurrence to `in_meeting`.
4. **Talk for a minute, then end the meeting** — the session runs `stopping → uploading → post_processing_completed`; the occurrence advances through `transcribing → summarizing → sending_recap → completed`, and eligible attendees receive the recap email.
5. **Where diagnostics land on failure** — the failure webhook carries `diagnosticsKeys`; the files appear as artifacts on the occurrence detail page (screenshot, page HTML, console/bot logs), and `GET /v1/bots/:id/diagnostics` returns the state history and redacted log tail while the runtime instance is alive. Audit events record each transition.

Also verify the deployed container is the new one: `curl -s https://<meeting-api domain>/_ops/health | jq` and confirm `version` and `containerInstanceId` changed.

## Sizing

`deploy/bot-container/wrangler.jsonc` runs up to 6 container instances (`standard-2`); `/_ops/ready` reports `at capacity` when the per-instance concurrent session cap is reached. Raise `max_instances`/`instance_type` for more simultaneous meetings.
