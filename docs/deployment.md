# Deployment

This is the single supported production path. It deploys two workers into your Cloudflare account: the main `minutesbot` Worker (admin UI + API + email + queue + cron) and the `minutesbot-meeting-bot` container worker (Teams recording runtime).

The checked-in configs intentionally contain placeholders (`<D1_DATABASE_ID>`, `example.com` domains) — no real account or database ids live in source. Setup patches your values in locally; the deploy scripts refuse to deploy while placeholders remain.

## 1. Prerequisites

- A Cloudflare account with Workers (paid plan: Containers, Queues, and D1 are used), and a domain whose DNS zone is on that account.
- `pnpm` 9, Node 22+, and Docker (for the bot container image build).
- `pnpm install`, then authenticate wrangler: `wrangler login` (or set `CLOUDFLARE_API_TOKEN`). If your login can access multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` (see `.env.example`).

You will pick four hostnames on your zone and one recorder mailbox, for example:

| Purpose | Example | Where it lands |
| --- | --- | --- |
| Admin UI (`APP_BASE_URL`) | `app.yourcompany.com` | main worker custom domain |
| API (`API_BASE_URL`) | `api.yourcompany.com` | main worker custom domain |
| Bot webhooks (`BOT_WEBHOOK_BASE_URL`) | `meeting.yourcompany.com` | main worker custom domain |
| Bot runtime API (`BOT_API_BASE_URL`) | `meeting-api.yourcompany.com` | bot container worker custom domain |
| Recorder mailbox | `notetaker@yourcompany.com` | Email Routing -> main worker |

## 2. First-time setup

```bash
pnpm setup:cloudflare
```

Interactive: prompts for the four hostnames and the recorder email (defaults come from `.env` if you created one from `.env.example`). Non-interactive:

```bash
pnpm setup:cloudflare -- \
  --app-domain app.yourcompany.com \
  --api-domain api.yourcompany.com \
  --meeting-domain meeting.yourcompany.com \
  --meeting-api-domain meeting-api.yourcompany.com \
  --recorder-email notetaker@yourcompany.com
```

What it automates:

- validates prerequisites (pnpm, wrangler + `wrangler whoami`, Docker presence),
- patches domains, recorder email, and `send_email` sender into `wrangler.jsonc` and `deploy/bot-container/wrangler.jsonc` (comments preserved),
- creates-or-verifies the D1 database `minutesbot`, R2 bucket `minutesbot-artifacts`, and queues `minutesbot-jobs` + `minutesbot-dlq`, patches the `database_id`, and applies remote migrations.

Add `--dry-run` to print the full plan (config replacements + resource plan + manual steps) without changing anything. `pnpm cloudflare:ensure [--dry-run]` re-runs just the resource create-or-verify step at any time; it is idempotent.

## 3. Secrets

Set with wrangler — never in `.env`, source, or D1:

```bash
wrangler secret put AI_API_KEY            # OpenAI(-compatible) key: recap generation (gpt-5.5 default)
                                          # and Whisper transcription unless the next secret is set
wrangler secret put TRANSCRIPTION_API_KEY # optional: separate key for a whisper-compatible endpoint
wrangler secret put SESSION_SECRET        # only for admin-token auth mode (see security.md)
```

`BOT_INTERNAL_TOKEN` (internal auth between the two workers) is generated and pushed to both workers automatically by `pnpm bot:deploy` — do not set it manually.

## 4. Email Routing (manual, once)

Wrangler cannot configure Email Routing; do this in the Cloudflare dashboard for your zone:

1. **Email > Email Routing**: enable it (adds the required MX/TXT records).
2. Create a routing rule: the recorder address (e.g. `notetaker@yourcompany.com`) → **Send to Worker** → `minutesbot`. Any recorder aliases you configure in Settings must route to the same worker.
3. The `send_email` binding can only send from addresses on a zone with Email Routing enabled; the deploy uses the recorder address as the default sender. Recap recipients must be deliverable addresses; Cloudflare requires destination domains to accept the mail normally (no verification needed for arbitrary recipients when using `send_email` with allowed sender addresses).

## 5. Deploy

```bash
pnpm deploy        # = deploy:production
```

`scripts/deploy-minutesbot.ts` runs, in order: resource create-or-verify (incl. remote migrations and `database_id` patch) → placeholder validation → workspace/web asset build → `wrangler deploy` → post-deploy smoke checks via `pnpm check`. A `deploy:staging` variant exists but requires an explicit `env.staging` block in `wrangler.jsonc` (the script fails closed without one).

### Cloudflare Workers Builds

If you deploy from a connected Git repository in Cloudflare, use:

```bash
pnpm run build
```

as the build command and:

```bash
npx wrangler deploy
```

as the deploy command. This repository defaults Workers Builds to the `minutes.bot` zone when no domain variables are provided:

- `APP_BASE_URL=https://app.minutes.bot`
- `API_BASE_URL=https://api.minutes.bot`
- `BOT_WEBHOOK_BASE_URL=https://meeting.minutes.bot`
- `BOT_API_BASE_URL=https://meeting-api.minutes.bot`
- `RECORDER_EMAIL=notetaker@minutes.bot`

For a different zone, set `MINUTESBOT_DOMAIN=yourcompany.com` or provide the explicit Cloudflare build environment variables below so the build can patch the checked-in placeholder domains before Wrangler deploys:

- `APP_BASE_URL=https://app.yourcompany.com`
- `API_BASE_URL=https://api.yourcompany.com`
- `BOT_WEBHOOK_BASE_URL=https://meeting.yourcompany.com`
- `BOT_API_BASE_URL=https://meeting-api.yourcompany.com`
- `RECORDER_EMAIL=notetaker@yourcompany.com` (or `DEFAULT_RECORDER_EMAIL`)

Without a default or those values, the build fails before provisioning/deploy instead of letting Wrangler try to attach `example.com` routes.

## 6. Deploy the bot container

```bash
pnpm bot:deploy
```

`scripts/deploy-bot-container.ts`:

1. generates `.wrangler/bot-container.jsonc` from `deploy/bot-container/wrangler.jsonc` with a fresh `BOT_CONTAINER_INSTANCE_ID` (so Cloudflare Containers stop routing to an old sleeping instance) and the current git sha as `BOT_RUNTIME_VERSION`,
2. runs `wrangler deploy --config …`, which builds `Dockerfile.bot` with your local Docker and pushes the image,
3. provisions `BOT_INTERNAL_TOKEN`: if missing on either worker (or `--rotate-token` is passed), a fresh random token is generated and set as a secret on **both** workers. The token is never printed or stored anywhere else.

If the main worker has not been deployed yet, step 3 tells you to run `pnpm deploy` first and rerun `pnpm bot:deploy`.

## 7. Verify

```bash
pnpm check
```

Checks `GET /api/health` and `/api/ready` on the API, `/_ops/health` and `/_ops/ready` on the bot runtime, and (when `MINUTESBOT_ADMIN_TOKEN` is set, admin-token mode only) an R2 round trip via `POST /api/admin/test-r2`. Non-zero exit on any failure, with a special diagnosis when your zone still resolves through non-Cloudflare nameservers.

Then open the admin UI, finish Settings (company name, allowed domains, retention), use the built-in test actions (D1/R2/bot/AI/email), and run a live meeting test per [meeting-bot-runtime.md](meeting-bot-runtime.md).

## DNS and custom domains

`wrangler deploy` creates the custom domains from the `routes` arrays automatically, but only if each hostname belongs to a zone on the deploying account. Traffic will not arrive until the domain's nameservers point at Cloudflare — `pnpm check` detects the common "zone still on previous host" case.

## Admin access

By default production requires Cloudflare Access in front of the admin UI/API (`ALLOW_ADMIN_TOKEN_AUTH=false`): create an Access application for the app domain and set the `CLOUDFLARE_ACCESS_AUD`, `CLOUDFLARE_ACCESS_JWKS_URL`, and `CLOUDFLARE_ACCESS_ISSUER` vars. For development-style deployments you can instead set `ALLOW_ADMIN_TOKEN_AUTH=true` plus the `SESSION_SECRET` secret. Details in [security-access-control.md](security-access-control.md).
