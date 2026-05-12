# minutesbot

minutesbot is an open-source, self-hosted, single-tenant Microsoft Teams meeting notetaker control plane. It coordinates meeting invites, scheduling, Attendee bot creation, Attendee webhooks, transcript artifact storage, AI summaries, recipient filtering, email delivery, retention, and audit visibility.

minutesbot does not directly record Teams meetings. Attendee joins meetings and uploads an MP3 recording to minutesbot's R2 bucket; minutesbot then transcribes that recording and generates the recap.

This repository is Cloudflare-first. The minutesbot control plane runs on Cloudflare Workers, Workers Static Assets, D1, R2, Queues, Workflows, and Email Routing. Attendee itself cannot be rewritten into Workers/D1/R2 without a separate product rewrite; the supported Cloudflare-hosted option is upstream Attendee on Cloudflare Containers with external Postgres and Redis-compatible services.

## Architecture

- React + Vite admin UI hosted on Workers Static Assets.
- Hono API Worker for settings, dashboards, retry actions, artifacts, audit logs, and Attendee webhooks.
- Cloudflare Email Worker for inbound recorder mailbox invites.
- Cloudflare D1 for metadata and audit state.
- Cloudflare R2 for raw invites, Attendee-uploaded recordings, transcript files, summaries, and artifacts.
- Cloudflare Queues and Workflows for durable bot creation, transcript finalization, summaries, email, and cleanup.
- Fetch-based Attendee REST client in `packages/attendee-client`.
- Optional Cloudflare Container router for self-hosted upstream Attendee in `deploy/attendee-container`.

Demo domains use `https://minutesbot-admin.wgsglobal.app` for the admin UI, `https://minutesbot-api.wgsglobal.app` for API callbacks, `https://minutesbot-webhook.wgsglobal.app` for Attendee webhooks, Attendee hosted services at `https://app.attendee.dev`, and `notetaker@wgs.bot`.

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
wrangler secret put TRANSCRIPT_LINK_SECRET
```

## Commands

- `pnpm build`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm run deploy`
- `pnpm setup:cloudflare`
- `pnpm attendee:prepare`
- `pnpm attendee:deploy`
- `pnpm check`

## Docs

- [Architecture](docs/architecture.md)
- [Cloudflare setup](docs/cloudflare-setup.md)
- [Attendee setup](docs/attendee-setup.md)
- [Attendee Container deployment](deploy/attendee-container/README.md)
- [Security](docs/security.md)
- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Local development](docs/local-development.md)
- [Access control](docs/security-access-control.md)

## License Notes

This repo is MIT licensed. Attendee is separate software with its own license. Review Attendee's Elastic License 2.0 terms, including managed-service restrictions, before deploying or offering services around it.
