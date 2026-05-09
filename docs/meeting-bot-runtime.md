# Meeting Bot Runtime

minutesbot includes its own first-party Teams meeting bot runtime. It does not clone, fork, vendor, or deploy the upstream Attendee repository.

The runtime is split into:

- `apps/bot-runtime`: Node/TypeScript Hono service that exposes the bot API, drives the browser/ffmpeg recording adapter, uploads recordings, and emits signed webhooks.
- `deploy/bot-container`: Cloudflare Container router that runs the bot runtime and stores uploaded recordings in the minutesbot R2 bucket.
- `packages/bot-client`: Fetch client used by Workers and tests.

## Required Secrets

```bash
wrangler secret put BOT_API_KEY
wrangler secret put BOT_WEBHOOK_SECRET
wrangler secret put TEAMS_RECORDER_PASSWORD --config deploy/bot-container/wrangler.jsonc
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
```

Set `TEAMS_RECORDER_EMAIL` as a non-secret var in the bot container config. The runtime prefers that service account and can fall back to guest join when allowed by tenant policy.

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

After recording, the bot runtime uploads `recordings/<meetingId>/recording.mp3` to R2 and emits `post_processing_completed`. The existing transcript workflow then reads the R2 MP3, transcribes it with the configured OpenRouter/Whisper provider, stores transcript artifacts, and queues the recap.

## Health

Use:

```text
https://meeting-api.minutes.bot/_ops/health
```

The health response reports missing runtime pieces such as `BOT_API_KEY`, `BOT_WEBHOOK_SECRET`, `TEAMS_RECORDER_PASSWORD`, `chromium`, or `ffmpeg`.
