# Meeting Bot Runtime

minutesbot includes its own first-party Teams meeting bot runtime. It does not clone, fork, vendor, or deploy the upstream Attendee repository.

The runtime is split into:

- `apps/bot-runtime`: Node/TypeScript Hono service that exposes the bot API, drives the guest Teams browser flow, captures browser audio through PulseAudio/ffmpeg, uploads recordings, and emits managed webhooks.
- `deploy/bot-container`: Cloudflare Container router that runs the bot runtime and stores uploaded recordings in the minutesbot R2 bucket.
- `packages/bot-client`: Fetch client used by Workers and tests.

## Required Secrets

```bash
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
```

The runtime joins Teams as a guest using the configured bot display name. `pnpm deploy:oneshot` generates and pushes the internal meeting bot token automatically; admins do not configure bot API or webhook keys.
Use `pnpm deploy:oneshot --env production` for production deploys. For container-only updates, `pnpm bot:deploy` generates `.wrangler/oneshot-bot.jsonc` with a fresh `BOT_CONTAINER_INSTANCE_ID` and current git `BOT_RUNTIME_VERSION` before running Wrangler, so Cloudflare Containers do not keep routing to an old sleeping instance.

## Runtime Contract

The Worker creates a bot with:

```json
{
  "meeting_url": "https://teams.microsoft.com/l/meetup-join/...",
  "bot_name": "minutesbot",
  "recording_settings": { "format": "mp3" },
  "external_media_storage_settings": {
    "bucket_name": "minutesbot-artifacts",
    "recording_file_name": "recordings/<meetingId>/recording.mp3"
  },
  "webhooks": [{ "url": "https://meeting.minutes.bot/api/webhooks/bot", "triggers": ["bot.state_change"] }]
}
```

After Teams admits the browser to the lobby or meeting, the bot runtime records browser audio from a PulseAudio monitor, uploads `recordings/<meetingId>/recording.mp3` to R2, and emits `post_processing_completed`. The existing transcript workflow then reads the R2 MP3, transcribes it with the configured OpenRouter/Whisper provider, stores transcript artifacts, and queues the recap.

## Health

Use:

```text
https://meeting-api.minutes.bot/_ops/health
```

The health response reports missing runtime pieces such as `chromium`, `ffmpeg`, or `pulseaudio`.
After a bot runtime deploy, compare `version`, `diagnosticVersion`, and `containerInstanceId` with the previous response to confirm the new container is serving traffic.
