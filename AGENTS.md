# AGENTS.md requirements

Project purpose:
Build minutesbot: an open-source, self-hosted, single-tenant Teams meeting notetaker.

Architecture constraints:
- Use TypeScript.
- Use pnpm workspaces.
- Use React + Vite for the admin frontend.
- Use Hono for Cloudflare Worker APIs.
- Use Cloudflare D1 for metadata.
- Use Cloudflare R2 for raw invites, transcripts, summaries, and artifacts.
- Use Cloudflare Email Workers for inbound meeting invites.
- Use Cloudflare Queues and Workflows for scheduling and async processing.
- Use the built-in first-party meeting bot runtime in this repo.
- Do not use a separate Attendee API.
- Do not fork Attendee.
- Do not vendor Attendee into this repo.
- Implement packages/bot-client to wrap the built-in meeting bot runtime API.
- Do not require user-managed bot API or webhook keys; deployment manages internal bot auth automatically.
- Store only secret status or secret references in D1.
- External attendees must never receive summaries by default.
- Transcript content should be stored in R2, not D1.
- Use Cloudflare service bindings where possible instead of calling Cloudflare REST APIs from Workers.
- Do not log secrets or tokens.
- Add tests for every package and major route.

Development commands:
- Install dependencies: pnpm install
- Test: pnpm test
- Typecheck: pnpm typecheck
- Lint: pnpm lint
- Build: pnpm build
- Local dev: pnpm dev
- Deploy: pnpm run deploy
- Local migrations: pnpm db:migrate:local
- Remote migrations: pnpm db:migrate:remote
- Setup Cloudflare resources: pnpm setup:cloudflare
- Health check: pnpm check

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
