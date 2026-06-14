# Troubleshooting

Start with the occurrence detail page (statuses + last error), the Logs page (audit events), and `pnpm check`. Bot-side failures carry a `failureStage` from the runtime (see `botFailureStages` in `packages/bot-client/src/types.ts`) plus uploaded diagnostics (screenshot, page HTML, console log) under the occurrence's artifacts.

## Invite ingestion

- **Invite never arrives** — verify the Email Routing rule sends the recorder address to the `minutesbot` worker, and that the inbound address matches `recorderEmail` or `recorderAliasEmails` in Settings. Every received message appears in `inbound_messages`, even rejected ones; if there is no row, mail is not reaching the worker.
- **Invite rejected** — the row's `rejection_reason` is explicit: `REJECTED_INVALID_RECIPIENT` (wrong recorder address), `REJECTED_UNAUTHENTICATED_SENDER` (SPF/DKIM/DMARC failed; sender spoofing protection — disable `policy.requireAuthenticatedSender` only if you understand the risk), `REJECTED_NO_TEAMS_LINK` (no Teams join URL in body/DESCRIPTION/LOCATION), `REJECTED_EXTERNAL_ORGANIZER` (organizer domain not allowed; add the domain or disable `policy.rejectExternalOrganizers`), `REJECTED_NO_ELIGIBLE_RECIPIENTS`, or `REJECTED_PARSE_ERROR` (inspect the raw invite artifact in R2).
- **Duplicate invite ignored** — expected: dedup by content hash and Message-ID. Forwarded copies of the same invite are processed once.
- **Recurring meeting not expanded** — check the series row in `calendar_events`: `is_recurring` should be 1 and `expanded_until` should be in the future. Occurrences are only created inside the rolling window (`scheduling.recurrenceExpansionDays`, default 180 days); occurrences further out appear as the daily `expand_recurrences` job advances the window. Exotic RRULEs that the expander cannot handle are logged with a parse warning — check the audit log and the raw invite artifact.
- **One occurrence of a series is wrong/missing** — per-occurrence updates (`RECURRENCE-ID` overrides) and cancellations (EXDATE) apply only to that occurrence; verify which inbound message last touched it via `last_inbound_message_id` and the audit trail.

## Bot / recording

- **Teams requires sign-in** (`failureStage: sign_in_required`) — the meeting does not allow anonymous/guest join. Fix in the Teams admin center (Meetings → Meeting settings → "Anonymous users can join a meeting") or in the meeting's organizer options. The bot only joins as a guest; it has no Microsoft account.
- **Bot stuck in lobby** (`lobby_timeout`) — nobody admitted the bot within `bot.maxWaitingRoomMinutes`. Admit "Notetaker (minutesbot)" from the lobby, raise the wait budget, or change the meeting's lobby policy ("Who can bypass the lobby"). The session fails over and retries up to `bot.maxJoinAttempts` while the meeting is running.
- **Meeting canceled** — a cancellation invite marks the occurrence `canceled` and a `cancel_bot` job tears down any active session. If the bot joined anyway, the organizer likely canceled in a way that never emailed the recorder mailbox; cancel from the occurrence page and check that cancellations reach the recorder address.
- **Meeting never started** (`meeting_not_started_timeout`) — the bot waited `joinTimeoutSeconds` on the pre-join screen; same knobs as the lobby case.
- **No audio captured** (`audio_setup` failure, or a silent recording) — `/_ops/health` reports the runtime's `pulseaudio`, `ffmpeg`, and `chromium` checks; if any is failing the container image is broken — rebuild with `pnpm bot:deploy`. A silent-but-successful recording usually means the meeting genuinely had no speech, or the bot was muted into an empty breakout.
- **Recording upload failed** (`upload`) — the runtime PUTs to the worker's `/internal/recordings` endpoint with the internal token. Check: `BOT_INTERNAL_TOKEN` drift between workers (rerun `pnpm bot:deploy`, or `--rotate-token`), the `x-recording-bucket` header matching `BOT_RECORDING_BUCKET_NAME`, and the 200 MB upload cap. Diagnostics keys arrive on the failure webhook.
- **Bot session stuck / container died** — heartbeats stop and the per-minute cron fails the session over within `scheduling.staleSessionMinutes` (default 10), logging `bot.stale_recovered`. No action needed beyond checking why the container died (`wrangler tail --config .wrangler/bot-container.jsonc`).

## Transcription / recap / email

- **Whisper failed** (transcript `failed_retryable`/`failed_terminal`) — check `transcripts.last_error`. Common causes: missing/invalid `AI_API_KEY` (or `TRANSCRIPTION_API_KEY` if set), a custom `transcription.baseUrl` that is not whisper-compatible, a recording over the provider's size limit, or the recording object missing from R2 (see upload failures above). Retryable failures back off automatically; use "Retry transcription" after fixing credentials.
- **GPT recap failed** (recap `failed_terminal`) — the engine demands strict JSON and already retried once with a repair prompt. Check `recaps.last_error`: schema-violating output usually means the configured `recap.model` is too weak or a custom `recap.baseUrl` is not OpenAI-compatible. Default is `gpt-5.5` via the OpenAI API. Verify with the Setup page's AI test action, then "Retry recap".
- **Cloudflare email send failed** (delivery `failed`) — the `SEND_EMAIL` binding rejects senders not in `allowed_sender_addresses` (rerun `pnpm setup:cloudflare` if you changed the sender), and the sender's zone must have Email Routing enabled. Per-recipient errors are stored on each `email_deliveries` row; use "Retry delivery". The Setup page's email test sends a sample recap to the configured test recipient.
- **External recipients filtered out** — **this is policy, not a bug.** Recaps are only ever sent to attendees whose email domain is in the admin-configured allowlist; external attendees never receive recaps, and the settings schema makes the policy non-configurable (`sendToAllowedDomainsOnly: true`, `sendToExternalAttendees: false` are literal types). Excluded attendees are listed on the meeting detail page with `skipped_policy` / exclusion reasons. If an internal domain was filtered, add it (or enable `policy.allowSubdomains` for subdomain mail like `user@mail.yourcompany.com`).
- **Recap "completed" but nobody got mail** — occurrence status `completed_no_eligible_recipients`: every attendee was external. Expected under the policy above.

## Jobs

- **Job stuck pending** — the per-minute cron should sweep it; if crons are not firing, confirm both `triggers.crons` entries survived any config edit and the worker deployed cleanly.
- **Job dead-lettered** — retries exhausted; the audit log has `job.dead_letter` with the final error. Fix the cause, then `POST /api/jobs/:id/requeue`.
