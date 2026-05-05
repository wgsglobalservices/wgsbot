# Attendee on Cloudflare Containers

This scaffold deploys upstream Attendee as Cloudflare Containers behind a small Worker router. It is the closest Cloudflare-hosted option for Attendee, but it is not Cloudflare-only: Attendee still requires external Postgres and Redis-compatible services.

## What Runs Here

- `AttendeeWebContainer`: proxies HTTPS requests to Attendee's Django/Gunicorn API on port 8000.
- `AttendeeWorkerContainer`: runs the Attendee Celery worker.
- `AttendeeSchedulerContainer`: runs Attendee's scheduler command.

The container image is built from the unvendored upstream checkout at `.attendee/upstream`, prepared by:

```bash
pnpm attendee:prepare
```

## Required Cloudflare Setup

Install root dependencies, prepare Attendee, then deploy this router:

```bash
pnpm install
pnpm attendee:prepare
wrangler secret put DATABASE_URL --config deploy/attendee-container/wrangler.jsonc
wrangler secret put REDIS_URL --config deploy/attendee-container/wrangler.jsonc
wrangler secret put SECRET_KEY --config deploy/attendee-container/wrangler.jsonc
pnpm attendee:deploy
```

Set additional Attendee/provider secrets as needed:

```bash
wrangler secret put AWS_ACCESS_KEY_ID --config deploy/attendee-container/wrangler.jsonc
wrangler secret put AWS_SECRET_ACCESS_KEY --config deploy/attendee-container/wrangler.jsonc
wrangler secret put AWS_STORAGE_BUCKET_NAME --config deploy/attendee-container/wrangler.jsonc
wrangler secret put AWS_S3_ENDPOINT_URL --config deploy/attendee-container/wrangler.jsonc
wrangler secret put DEEPGRAM_API_KEY --config deploy/attendee-container/wrangler.jsonc
wrangler secret put ZOOM_CLIENT_ID --config deploy/attendee-container/wrangler.jsonc
wrangler secret put ZOOM_CLIENT_SECRET --config deploy/attendee-container/wrangler.jsonc
```

Use R2 S3 API credentials for the AWS/S3 settings if you want Attendee object storage on Cloudflare R2.

## Operations

- Health/config check: `https://attendee.wgs.bot/_ops/health`
- Start or restart background containers: `POST https://attendee.wgs.bot/_ops/start-workers`
- The cron trigger calls the same background start path every 30 minutes as a best-effort keepalive.

After Attendee is reachable, set the minutesbot Worker secret/config to point at this domain:

```bash
ATTENDEE_API_BASE_URL=https://attendee.wgs.bot
wrangler secret put ATTENDEE_API_KEY
wrangler secret put ATTENDEE_WEBHOOK_SECRET
```

The minutesbot webhook URL for Attendee is:

```text
https://wgs.bot/api/webhooks/attendee
```

## Feasibility Boundary

Attendee cannot run on Cloudflare Workers, D1, Queues, and R2 alone. Upstream Attendee is a Dockerized Django/Celery system with Chrome, PulseAudio, ffmpeg, Postgres, Redis, and native Linux package requirements. Cloudflare Containers can host the Dockerized application, but Postgres and Redis remain external companion services.
