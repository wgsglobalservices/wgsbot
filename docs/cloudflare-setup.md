# Cloudflare Setup

Run `pnpm setup:cloudflare` for guided commands. The script prints commands and intentionally does not accept secrets as command-line arguments.

Use `pnpm deploy:oneshot --env production` for first-time Cloudflare-first deployments that include the Attendee Container router. Use `pnpm run deploy` for later minutesbot-only deployments. In Cloudflare build settings, set the deploy command to `pnpm run deploy`, not `npx wrangler deploy`, because the package script first runs the idempotent Cloudflare queue check required by this project.

Workers Builds defaults to `npx wrangler deploy` if the deploy command is not customized. The root `pnpm run build` command also checks for `WORKERS_CI=1` and creates or verifies the required D1 database, R2 bucket, queues, and D1 migrations before the workspace build. It rewrites the build container's `wrangler.jsonc` with the actual D1 `database_id`, so the default deploy command still has valid bindings available. Queue consumers are managed outside the checked-in Wrangler config because Cloudflare allows one consumer per queue and re-declaring an existing consumer can make deploy fail with code `11004`. Set `MINUTESBOT_DEPLOY_ENV=staging` in Workers Builds only when intentionally deploying the staging environment; otherwise production resource names are used.

This repo is Cloudflare-first for the minutesbot control plane. The Worker serves the API and the Vite admin UI through Workers Static Assets; D1, R2, Queues, Workflows, and Email Routing are the production runtime.

## One-Shot Deploy

Create `.env.oneshot` from the example, fill in account/domain/provider values, and run:

```bash
cp .env.oneshot.example .env.oneshot
pnpm install
pnpm deploy:oneshot --env production
```

The script validates pnpm, Wrangler auth, Docker, `.env.oneshot`, external Postgres/Redis URLs, R2 S3 credentials, Attendee secrets, AI/transcription keys, and session/email settings. It then generates ignored Wrangler configs under `.wrangler/`, ensures D1/R2/queues/migrations, prepares upstream Attendee in `.attendee/upstream`, deploys Attendee on Cloudflare Containers, pushes secrets, deploys minutesbot, and runs health/smoke checks.

Run `pnpm deploy:oneshot --env production --dry-run` to validate the plan without mutating Cloudflare resources.

If Cloudflare Access is enabled for the Worker, keep these `.env.oneshot` values set so the Worker validates Access JWTs in addition to Cloudflare's edge check:

```text
CLOUDFLARE_ACCESS_AUD=13f67694a98579897f6175043bb595df17afdfd5129d44c33e8b937b5576ae71
CLOUDFLARE_ACCESS_JWKS_URL=https://esau.cloudflareaccess.com/cdn-cgi/access/certs
CLOUDFLARE_ACCESS_ISSUER=https://esau.cloudflareaccess.com
```

## DNS Cutover

Public traffic will not reach Workers until the relevant domain is active in Cloudflare DNS and the configured custom domains exist. The main minutesbot Worker custom domain is `app.minutes.bot`. Runtime config uses `https://api.minutes.bot` for API calls and `https://admin.minutes.bot` for the admin UI and Attendee webhook base URL. Configure the separate Attendee Container custom domain, such as `attendee.company.com`, before running the real deployment.

## Resources

- D1 database binding: `DB`
- R2 bucket binding: `ARTIFACTS`
- Attendee external media bucket var: `ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME`
- Queues: `INVITE_QUEUE`, `SUMMARY_QUEUE`, `EMAIL_QUEUE`
- Workflow bindings: `MEETING_WORKFLOW`, `TRANSCRIPT_WORKFLOW`, `SUMMARY_WORKFLOW`, `CLEANUP_WORKFLOW`
- Optional email binding: `SEND_EMAIL`
- Optional Attendee Container deployment: `deploy/attendee-container`

## Environments

The checked-in `wrangler.jsonc` uses `app.minutes.bot` as the main Worker custom domain. The one-shot deploy script writes concrete ignored configs from `.env.oneshot` so account IDs, sender addresses, bucket names, and the separate Attendee Container host do not need to be committed.

## Commands

```bash
wrangler d1 create minutesbot
wrangler r2 bucket create minutesbot-artifacts
pnpm cloudflare:ensure
CLOUDFLARE_API_TOKEN=... pnpm cloudflare:ensure-webhook-bypass
wrangler secret put ATTENDEE_API_KEY
wrangler secret put ATTENDEE_WEBHOOK_SECRET
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
pnpm db:migrate:remote
pnpm run deploy
```

Configure Email Routing to send `notetaker@minutes.bot` to the Email Worker. Any notetaker aliases configured in Setup must also route to the same Email Worker. Configure `app.minutes.bot` as the main Worker custom domain, plus the separate Attendee Container custom domain, in Cloudflare DNS/routes.

Protect the admin UI with Cloudflare Access for the MVP.

## Attendee External Media Storage

Create Cloudflare R2 S3 credentials scoped to the `minutesbot-artifacts` bucket with object read/write access, then save them in Attendee under External Media Storage Credentials:

```text
Endpoint URL: https://<account_id>.r2.cloudflarestorage.com
Region Name: auto
Bucket name used by minutesbot: minutesbot-artifacts
```

minutesbot supplies `recording_settings.format = mp3` and `external_media_storage_settings.bucket_name = ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME` when creating each Attendee bot. Attendee uploads the recording to `recordings/<meetingId>/recording.mp3`, and minutesbot reads that R2 object for Whisper/OpenRouter transcription.

## Attendee Boundary

For one-shot Cloudflare-first deployments, use `deploy/attendee-container` to run upstream Attendee on Cloudflare Containers, backed by external Postgres and Redis-compatible services. Set `ATTENDEE_API_BASE_URL` to the Attendee Container domain and configure the webhook URL in Attendee:

```text
https://admin.minutes.bot/api/webhooks/attendee
```
