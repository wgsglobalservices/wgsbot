# minutesbot

minutesbot is an open-source, self-hosted, single-tenant Microsoft Teams meeting notetaker control plane. It coordinates meeting invites, scheduling, Attendee bot creation, Attendee webhooks, transcript artifact storage, AI summaries, recipient filtering, email delivery, retention, and audit visibility.

minutesbot does not directly record Teams meetings. The separate self-hosted Attendee backend joins meetings and performs recording/transcription.

## Architecture

- React + Vite admin UI hosted on Cloudflare Pages or Workers Static Assets.
- Hono API Worker for settings, dashboards, retry actions, artifacts, audit logs, and Attendee webhooks.
- Cloudflare Email Worker for inbound recorder mailbox invites.
- Cloudflare D1 for metadata and audit state.
- Cloudflare R2 for raw invites, transcript files, summaries, and artifacts.
- Cloudflare Queues and Workflows for durable bot creation, transcript finalization, summaries, email, and cleanup.
- Fetch-based Attendee REST client in `packages/attendee-client`.

Demo domains use `https://minutes.bot`, `https://app.minutes.bot`, `https://api.minutes.bot`, `https://attendee.minutes.bot`, and `notetaker@meet.minutes.bot`.

Customer self-hosted examples use `https://notes.company.com`, `https://attendee.company.com`, and `notetaker@meet.company.com`.

## Quickstart

```bash
pnpm install
pnpm db:migrate:local
pnpm seed:dev
pnpm dev
```

Set secrets with Wrangler, never in D1 or source:

```bash
wrangler secret put ATTENDEE_API_KEY
wrangler secret put ATTENDEE_WEBHOOK_SECRET
wrangler secret put AI_API_KEY
wrangler secret put SESSION_SECRET
```

## Commands

- `pnpm build`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm run deploy`
- `pnpm setup:cloudflare`
- `pnpm check`

## Docs

- [Architecture](docs/architecture.md)
- [Cloudflare setup](docs/cloudflare-setup.md)
- [Attendee setup](docs/attendee-setup.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Local development](docs/local-development.md)

## License Notes

This repo is MIT licensed. Attendee is separate software with its own license. Review Attendee's Elastic License 2.0 terms, including managed-service restrictions, before deploying or offering services around it.
