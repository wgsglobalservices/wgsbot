# Cloudflare Setup

Run `pnpm setup:cloudflare` for guided commands. The script prints commands and intentionally does not accept secrets as command-line arguments.

Use `pnpm run deploy` for deployments. Do not run `npx wrangler deploy` directly, because `pnpm run deploy` first runs the idempotent Cloudflare queue check required by this project.

## Resources

- D1 database binding: `DB`
- R2 bucket binding: `ARTIFACTS`
- Queues: `INVITE_QUEUE`, `SUMMARY_QUEUE`, `EMAIL_QUEUE`
- Workflow binding: `MEETING_WORKFLOW`
- Optional email binding: `SEND_EMAIL`
- Optional service binding: `API_SERVICE`

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

Configure Email Routing to send `notetaker@meet.company.com` to the Email Worker. Configure custom domains such as `notes.company.com`, `api.company.com`, and `meet.company.com` in Cloudflare DNS/routes.

Protect the admin UI with Cloudflare Access for the MVP.
