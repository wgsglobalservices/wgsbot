# Troubleshooting

- Email Worker not receiving mail: verify Cloudflare Email Routing and recorder address or alias routing.
- Recorder email mismatch: confirm `recorderEmail` or `recorderAliasEmails` matches the inbound notetaker address, such as `notetaker@minutes.bot`.
- No Teams URL found: inspect raw invite artifact and confirm Teams join URL appears in body, DESCRIPTION, or LOCATION.
- Organizer domain rejected: add the organizer domain or disable external organizer rejection.
- No eligible recipients: verify allowed domains and attendee email addresses.
- Attendee auth failed: verify `ATTENDEE_API_KEY` with `wrangler secret put`.
- Bot stuck in waiting room: confirm meeting lobby policy and bot admission process.
- Bot fatal error: inspect Attendee logs and `bot_logs.update` webhook events.
- Transcript pending: confirm Attendee External Media Storage Credentials can write to the configured R2 bucket and that `recordings/<meetingId>/recording.mp3` exists.
- Transcript empty: confirm the bot joined, Attendee uploaded an MP3 recording, and the meeting had speech.
- Transcription incomplete: retry transcript fetch after Attendee post-processing completes and the R2 recording is present.
- Webhook signature invalid: ensure the base64 webhook secret matches Attendee configuration.
- Duplicate webhook ignored: expected when `idempotency_key` has already been processed.
- Outbound email failure: test provider configuration and sender verification.
- AI provider failure: verify AI base URL, model, and `AI_API_KEY`.
