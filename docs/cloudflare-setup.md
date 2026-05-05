# Cloudflare Setup

Run `pnpm setup:cloudflare` for guided commands. The script prints commands and intentionally does not accept secrets as command-line arguments.

Use `pnpm run deploy` for deployments. In Cloudflare build settings, set the deploy command to `pnpm run deploy`, not `npx wrangler deploy`, because the package script first runs the idempotent Cloudflare queue check required by this project.

Workers Builds defaults to `npx wrangler deploy` if the deploy command is not customized. The root `pnpm run build` command also checks for `WORKERS_CI=1` and creates or verifies the required D1 database, R2 bucket, queues, and D1 migrations before the workspace build. It rewrites the build container's `wrangler.jsonc` with the actual D1 `database_id`, so the default deploy command still has valid bindings available. Set `MINUTESBOT_DEPLOY_ENV=staging` in Workers Builds only when intentionally deploying the staging environment; otherwise production resource names are used.

This repo is Cloudflare-first for the minutesbot control plane. The Worker serves the API and the Vite admin UI through Workers Static Assets; D1, R2, Queues, Workflows, and Email Routing are the production runtime.

## Resources

- D1 database binding: `DB`
- R2 bucket binding: `ARTIFACTS`
- Queues: `INVITE_QUEUE`, `SUMMARY_QUEUE`, `EMAIL_QUEUE`
- Workflow binding: `MEETING_WORKFLOW`
- Optional email binding: `SEND_EMAIL`
- Optional Attendee Container deployment: `deploy/attendee-container`

## Environments

The root `wrangler.jsonc` includes `staging` and `production` environments. Production points at `https://wgs.minutes.bot` and `https://attendee.wgs.minutes.bot`. Staging uses separate route/resource names and must have its placeholder D1 database id replaced before use.

## Commands

```bash
wrangler d1 create minutesbot
wrangler r2 bucket create minutesbot-artifacts
pnpm cloudflare:ensure
wrangler secret put ATTENDEE_API_KEY
wrangler secret put ATTENDEE_WEBHOOK_SECRET
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
pnpm db:migrate:remote
pnpm run deploy
```

Use environment-specific commands when deploying staging:

```bash
wrangler d1 migrations apply minutesbot-staging --remote --env staging
pnpm deploy:staging
```

Configure Email Routing to send `notetaker@meet.company.com` to the Email Worker. Configure custom domains such as `notes.company.com`, `api.company.com`, and `attendee.company.com` in Cloudflare DNS/routes.

Protect the admin UI with Cloudflare Access for the MVP.

## Attendee Boundary

Attendee is not a Worker-native application. Use `deploy/attendee-container` to run upstream Attendee on Cloudflare Containers, backed by external Postgres and Redis-compatible services. Then set `ATTENDEE_API_BASE_URL` to the Attendee Container domain and configure the webhook URL in Attendee:

```text
https://<api-domain>/api/webhooks/attendee
```
