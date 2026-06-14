# minutesbot

minutesbot is an open-source, self-hosted, single-tenant Microsoft Teams meeting notetaker that runs entirely on your Cloudflare account.

Invite a recorder mailbox (e.g. `notetaker@yourcompany.com`) to a Teams meeting and minutesbot does the rest: Cloudflare Email Routing delivers the invite to the Worker, which parses the MIME + ICS (including recurring series), expands occurrences, and schedules a bot. At meeting time a Cloudflare Container joins Teams as a guest with Playwright, records the audio to MP3 (PulseAudio + ffmpeg), and uploads it to R2. The pipeline then transcribes with Whisper, generates a structured recap with an OpenAI-compatible model (GPT-5.5 by default, strict JSON), and emails the recap — only to attendees on your admin-allowed domains. External attendees never receive recaps. A React admin UI covers settings, meeting timelines, retries, audit logs, and retention.

Everything is Cloudflare-first: one main Worker (Hono API + admin SPA + inbound email + queue consumer + cron) backed by D1, R2, and Queues, plus a separately deployed bot container worker. No third-party meeting-bot service.

## Quickstart

Full guide: [docs/deployment.md](docs/deployment.md).

```bash
pnpm install
pnpm setup:cloudflare        # prereqs, domains/recorder email, D1/R2/queues, config patching
wrangler secret put AI_API_KEY
# Cloudflare dashboard: route the recorder address to the Worker (Email Routing)
pnpm deploy                  # migrations, build, deploy, smoke checks
pnpm bot:deploy              # bot container build + internal token provisioning
pnpm check                   # health checks
```

Local development ([docs/local-development.md](docs/local-development.md)):

```bash
pnpm install
pnpm db:migrate:local
pnpm seed:dev
pnpm dev
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | Workspace build (web assets + packages, typecheck per package) |
| `pnpm test` | Vitest across packages, apps, scripts, and deploy |
| `pnpm typecheck` / `pnpm lint` | Repo-wide TypeScript and ESLint |
| `pnpm dev` | Vite dev server for the admin UI |
| `pnpm setup:cloudflare [--dry-run]` | First-time setup: prereqs, domain/email patching, resources |
| `pnpm cloudflare:ensure [--dry-run]` | Create-or-verify D1/R2/queues, patch database id, migrations |
| `pnpm deploy` / `pnpm deploy:staging` | Deploy the main Worker (with validation + smoke checks) |
| `pnpm bot:deploy [--rotate-token]` | Deploy the bot container worker, provision `BOT_INTERNAL_TOKEN` |
| `pnpm check` | API + bot runtime health checks (+ authed R2 round trip) |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | D1 migrations |
| `pnpm seed:dev [--print]` | Seed local D1 with development settings |
| `pnpm env:template` | Print the `.env` template (`.env.example`) |

## Monitoring

Point an external uptime monitor at `https://<api domain>/api/health` (expect `200 {"ok":true}`) and `https://<meeting-api domain>/_ops/health` (expect `200`, `ok: true`). After a bot deploy, `version` and `containerInstanceId` in the latter should change.

## Docs

- [Architecture](docs/architecture.md) — components, data model, state machines, recurrence
- [Deployment](docs/deployment.md) — the production path end to end
- [Operations](docs/operations.md) — admin UI, retries, jobs/dead letters, retention
- [Troubleshooting](docs/troubleshooting.md) — failure modes from lobby timeouts to recap policy
- [Meeting bot runtime](docs/meeting-bot-runtime.md) — runtime API, webhooks, live test guide
- [Security](docs/security.md) and [Access control](docs/security-access-control.md)
- [Local development](docs/local-development.md)

## License

This repo is MIT licensed.
