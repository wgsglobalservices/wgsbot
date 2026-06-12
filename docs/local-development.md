# Local Development

```bash
pnpm install
pnpm db:migrate:local
pnpm seed:dev # prints a settings template to adapt; it does not write to the database
pnpm dev
```

The admin UI runs with Vite. Workers can be run with Wrangler locally using the root `wrangler.jsonc`.

For local meeting bot runtime work, use the mocked recorder in tests or run `apps/bot-runtime` with a fixture recording path. The repository does not use the upstream Attendee repo.

Invite parser fixtures live in `packages/invite-parser/src/fixtures`.

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
