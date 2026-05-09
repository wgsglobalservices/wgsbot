# Troubleshooting

- Email Worker not receiving mail: verify Cloudflare Email Routing and recorder address or alias routing.
- Recorder email mismatch: confirm `recorderEmail` or `recorderAliasEmails` matches the inbound notetaker address, such as `notetaker@minutes.bot`.
- No Teams URL found: inspect raw invite artifact and confirm Teams join URL appears in body, DESCRIPTION, or LOCATION.
- Organizer domain rejected: add the organizer domain or disable external organizer rejection.
- No eligible recipients: verify allowed domains and attendee email addresses.
- Meeting bot auth failed: rerun `pnpm deploy:oneshot --env production` so the managed internal bot token is regenerated and pushed.
- Bot stuck in waiting room: confirm meeting lobby policy and bot admission process.
- Bot fatal error: inspect meeting bot runtime logs and `bot.state_change` webhook events.
- Transcript pending: confirm the meeting bot runtime can write to the configured R2 bucket and that `recordings/<meetingId>/recording.mp3` exists.
- Transcript empty: confirm the bot joined, uploaded an MP3 recording, and the meeting had speech.
- Transcription incomplete: retry transcript fetch after meeting bot post-processing completes and the R2 recording is present.
- Webhook authorization invalid: rerun the one-shot deploy so minutesbot and the bot runtime receive the same managed internal token.
- Duplicate webhook ignored: expected when `idempotency_key` has already been processed.
- Outbound email failure: test provider configuration and sender verification.
- AI provider failure: verify AI base URL, model, and `AI_API_KEY`.
