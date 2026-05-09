# minutesbot

minutesbot is an open-source, self-hosted, single-tenant Microsoft Teams meeting notetaker. It coordinates meeting invites, scheduling, first-party meeting bot creation, signed bot webhooks, transcript artifact storage, AI summaries, recipient filtering, email delivery, retention, and audit visibility.

This repository is Cloudflare-first. The control plane runs on Cloudflare Workers, Workers Static Assets, D1, R2, Queues, Workflows, Email Routing, and a first-party Cloudflare Container meeting bot runtime. It does not use, clone, fork, vendor, or deploy the upstream Attendee repository.

## Architecture

- React + Vite admin UI hosted on Workers Static Assets.
- Hono API Worker for settings, dashboards, retry actions, artifacts, audit logs, and meeting bot webhooks.
- Cloudflare Email Worker for inbound recorder mailbox invites.
- Cloudflare D1 for metadata and audit state.
- Cloudflare R2 for raw invites, bot-uploaded recordings, transcript files, summaries, and artifacts.
- Cloudflare Queues and Workflows for durable bot creation, transcript finalization, summaries, email, and cleanup.
- Fetch-based meeting bot client in `packages/bot-client`.
- First-party meeting bot runtime in `apps/bot-runtime` deployed through `deploy/bot-container`.

The main Cloudflare Worker uses `https://app.minutes.bot` as the admin UI and `APP_BASE_URL`, `https://api.minutes.bot` as the public API base URL, and `https://meeting.minutes.bot` as the meeting bot webhook base URL. The meeting bot runtime API uses `https://meeting-api.minutes.bot`, with `notetaker@minutes.bot` as the recorder mailbox.

## Quickstart

```bash
pnpm install
pnpm db:migrate:local
pnpm seed:dev
pnpm dev
```

For a Cloudflare-first production deployment:

```bash
cp .env.oneshot.example .env.oneshot
# fill .env.oneshot with account, domain, bot runtime, and provider values
pnpm install
pnpm deploy:oneshot --env production
```

Set secrets with Wrangler, never in D1 or source:

```bash
wrangler secret put BOT_API_KEY
wrangler secret put BOT_WEBHOOK_SECRET
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
```

## Commands

- `pnpm build`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm run deploy`
- `pnpm deploy:oneshot --env production`
- `pnpm setup:cloudflare`
- `pnpm bot:deploy`
- `pnpm check`

## Docs

- [Architecture](docs/architecture.md)
- [Cloudflare setup](docs/cloudflare-setup.md)
- [Meeting bot runtime](docs/meeting-bot-runtime.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Local development](docs/local-development.md)
- [Access control](docs/security-access-control.md)

## License

This repo is MIT licensed.
