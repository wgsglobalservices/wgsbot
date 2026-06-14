# AGENTS.md requirements

Project purpose:
Build minutesbot: an open-source, self-hosted, single-tenant Teams meeting notetaker on Cloudflare.

Architecture constraints:
- Use TypeScript, pnpm workspaces, React + Vite (admin UI), and Hono (Worker APIs).
- One main Worker (root wrangler.jsonc) exports fetch (admin API + SPA assets), email (inbound invites), queue (minutesbot-jobs consumer), and scheduled (per-minute sweep + daily maintenance crons). Bindings: D1 `DB`, R2 `ARTIFACTS`, queue `JOBS_QUEUE` (DLQ minutesbot-dlq), `SEND_EMAIL`, `ASSETS`.
- The bot runtime is first-party: a Cloudflare Container (Dockerfile.bot, apps/bot-runtime) behind the deploy/bot-container worker, deployed separately via `pnpm bot:deploy`. Do not use, fork, or vendor any third-party meeting-bot service (e.g. Attendee); `packages/bot-client` wraps the built-in runtime API.
- Data model is occurrence-based (migrations/0009): inbound_messages -> calendar_events -> meeting_occurrences -> bot_sessions, plus transcripts, recaps, email_deliveries, attendees, allowed_domains, artifacts, audit_logs, and the durable `jobs` table. The jobs table is the source of truth for async work; queue messages are delivery hints swept by the per-minute cron.
- Recurrence: RRULE/RDATE/EXDATE expansion into a rolling window (default 180 days), per-occurrence overrides via RECURRENCE-ID, EXDATE on per-occurrence cancel (packages/recurrence, packages/invite-parser, packages/scheduler).
- Defaults: transcription via OpenAI Whisper (`whisper-1`, whisper-compatible endpoints supported, packages/transcription); recaps via OpenAI-compatible chat API (`gpt-5.5`) with strict zod-validated JSON and one repair retry (packages/summary-engine).
- Packages: shared, db, invite-parser, recurrence, scheduler, recipient-policy, bot-client, transcription, summary-engine, email-renderer, email-sender.
- Statuses live in packages/shared/src/status.ts; every async step persists one.
- Secrets only via `wrangler secret put` (AI_API_KEY, TRANSCRIPTION_API_KEY optional, SESSION_SECRET). BOT_INTERNAL_TOKEN is generated and pushed to both workers by `pnpm bot:deploy`; admins never manage bot API or webhook keys. D1 stores only secret status/references.
- Admin auth: Cloudflare Access by default in production; admin-token mode (SESSION_SECRET) only with explicit ALLOW_ADMIN_TOKEN_AUTH=true. Named environments fail closed.
- External attendees must never receive recaps; recipients are filtered to admin-allowed domains and the policy fields are literal types in the settings schema.
- Artifact bodies (raw invites, recordings, transcripts, recaps, diagnostics) live in R2 only; D1 holds pointers and hashes.
- Checked-in wrangler configs must contain placeholders (<D1_DATABASE_ID>, example.com domains), never real account or database ids. `pnpm setup:cloudflare` / `pnpm cloudflare:ensure` patch real values locally.
- Do not log secrets or tokens.
- Add tests for every package and major route; scripts have tests in scripts/*.test.ts.

Development commands:
- Install dependencies: pnpm install
- Test: pnpm test
- Typecheck: pnpm typecheck
- Lint: pnpm lint
- Build: pnpm build
- Local dev: pnpm dev
- First-time setup: pnpm setup:cloudflare [--dry-run]
- Ensure Cloudflare resources: pnpm cloudflare:ensure [--dry-run]
- Deploy main worker: pnpm deploy (deploy:staging needs an env.staging block)
- Deploy bot container: pnpm bot:deploy [--rotate-token]
- Local migrations: pnpm db:migrate:local
- Remote migrations: pnpm db:migrate:remote
- Seed local settings: pnpm seed:dev [--print]
- Health check: pnpm check
- Print env template: pnpm env:template

Do not build in MVP:
- custom Teams media bot
- Microsoft Graph transcript retrieval
- hosted SaaS multi-tenancy
- billing
- Stripe
- Slack
- CRM
- SCIM
- marketplace Teams app
- advanced RBAC
- custom branded templates
- native desktop app
- mobile app
