# Cloudflare Setup

Run `pnpm setup:cloudflare` for guided commands. The script prints commands and intentionally does not accept secrets as command-line arguments.

Use `pnpm deploy:oneshot --env production` for first-time Cloudflare-first deployments that include the first-party meeting bot container. Use `pnpm run deploy` for later minutesbot-only deployments. In Cloudflare Workers Builds, `pnpm run build` performs the idempotent D1/R2/queue setup before the platform runs `npx wrangler deploy`. The connected-build root config calls the meeting bot through `BOT_API_BASE_URL` instead of a service binding because Workers Builds force nested Wrangler deploys to the connected Worker name.

The Worker serves the API and Vite admin UI through Workers Static Assets. D1, R2, Queues, Workflows, Email Routing, and the meeting bot container are the production runtime.

## One-Shot Deploy

Create `.env.oneshot` from the example, fill in account/domain/provider values, and run:

```bash
cp .env.oneshot.example .env.oneshot
pnpm install
pnpm deploy:oneshot --env production
```

The script validates pnpm, Wrangler auth, Docker, `.env.oneshot`, AI/transcription keys, and session/email settings. It generates ignored Wrangler configs under `.wrangler/`, creates a managed internal meeting bot token, ensures D1/R2/queues/migrations, deploys the first-party meeting bot container, pushes secrets, deploys minutesbot, and runs health/smoke checks.

Run `pnpm deploy:oneshot --env production --dry-run` to validate the plan without mutating Cloudflare resources.

## DNS Cutover

Public traffic will not reach Workers until the relevant domain is active in Cloudflare DNS and the configured custom domains exist. The main minutesbot Worker custom domains are `app.minutes.bot`, `api.minutes.bot`, and `meeting.minutes.bot`. Runtime config uses `https://app.minutes.bot` for the admin UI and `APP_BASE_URL`, `https://api.minutes.bot` for public API calls, `https://meeting.minutes.bot` for the bot webhook base URL, and `https://meeting-api.minutes.bot` for the meeting bot runtime API.

## Resources

- D1 database binding: `DB`
- R2 bucket binding: `ARTIFACTS`
- Recording bucket var: `BOT_RECORDING_BUCKET_NAME`
- Service binding: `BOT_RUNTIME`
- Queues: `INVITE_QUEUE`, `SUMMARY_QUEUE`, `EMAIL_QUEUE`
- Workflow bindings: `MEETING_WORKFLOW`, `TRANSCRIPT_WORKFLOW`, `SUMMARY_WORKFLOW`, `CLEANUP_WORKFLOW`
- Optional email binding: `SEND_EMAIL`
- Meeting bot container deployment: `deploy/bot-container`

## Commands

```bash
wrangler d1 create minutesbot
wrangler r2 bucket create minutesbot-artifacts
pnpm cloudflare:ensure
CLOUDFLARE_API_TOKEN=... pnpm cloudflare:ensure-webhook-bypass
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
pnpm db:migrate:remote
pnpm run deploy
```

Configure Email Routing to send `notetaker@minutes.bot` to the Email Worker. Any notetaker aliases configured in Setup must also route to the same Email Worker. Configure `app.minutes.bot`, `api.minutes.bot`, and `meeting.minutes.bot` as main Worker custom domains plus `meeting-api.minutes.bot` as the separate meeting bot container custom domain.

Protect the admin UI with Cloudflare Access for the MVP.

## Recording Flow

minutesbot supplies `recording_settings.format = mp3` and `external_media_storage_settings.bucket_name = BOT_RECORDING_BUCKET_NAME` when creating each meeting bot. The first-party runtime uploads the recording to `recordings/<meetingId>/recording.mp3`, and minutesbot reads that R2 object for Whisper/OpenRouter transcription.
