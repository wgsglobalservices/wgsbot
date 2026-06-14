# Local Development

```bash
pnpm install
pnpm db:migrate:local   # applies migrations/ to the local D1 (.wrangler/state)
pnpm seed:dev           # seeds dev settings into local D1 (mock email provider)
pnpm dev                # Vite dev server for the admin UI (apps/web)
```

`pnpm seed:dev` writes a `parseSettings`-compatible settings document (and the mirrored `allowed_domains` rows) into the local database via `wrangler d1 execute --local`. Use `pnpm seed:dev -- --print` to inspect the SQL instead of executing it. The seed uses `example.com` as the allowed domain and recorder address — adjust in the Settings UI.

To run the Worker itself locally, use Wrangler with the root config (`wrangler dev`); the admin SPA dev server proxies API calls to it.

## Mock email provider

The seeded settings set `email.provider: "mock"`, which logs deliveries instead of sending — local runs can never email anyone. Switch to `cloudflare-email-service` only on a deployed Worker where the `SEND_EMAIL` binding exists.

## Local auth

With `ENVIRONMENT` unset/`development`, the API falls back to admin-token auth: set a `SESSION_SECRET` (e.g. in `.dev.vars`) and enter it in the admin UI. See [security-access-control.md](security-access-control.md).

## Bot runtime

The recording pipeline is fully mocked in tests; you do not need Docker or a Teams tenant for normal development. For bot runtime work, `apps/bot-runtime` runs as a plain Node service (`pnpm --filter @minutesbot/bot-runtime exec tsx src/server.ts`) and its Playwright/audio pieces are exercised by `apps/bot-runtime/src/*.test.ts` with fixtures. Real joins require the deployed container ([meeting-bot-runtime.md](meeting-bot-runtime.md)).

## Tests and checks

```bash
pnpm test        # vitest (packages, apps, scripts, deploy)
pnpm typecheck
pnpm lint
pnpm build
```

Invite parser fixtures live in `packages/invite-parser/src/fixtures`. Vitest aliases workspace packages to their sources (see `vitest.config.ts`), so cross-package tests run without a build step.
