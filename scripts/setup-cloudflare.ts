const commands = [
  "wrangler d1 create minutesbot",
  "wrangler r2 bucket create minutesbot-artifacts",
  "pnpm cloudflare:ensure",
  "CLOUDFLARE_API_TOKEN=... pnpm cloudflare:ensure-webhook-bypass",
  "wrangler secret put ATTENDEE_API_KEY",
  "wrangler secret put ATTENDEE_WEBHOOK_SECRET",
  "wrangler secret put AI_API_KEY",
  "wrangler secret put SESSION_SECRET",
  "cp .env.oneshot.example .env.oneshot",
  "pnpm deploy:oneshot --env production",
  "pnpm db:migrate:remote",
  "pnpm run deploy",
  "pnpm deploy:staging",
  "pnpm deploy:production",
  "pnpm attendee:prepare",
  "wrangler secret put DATABASE_URL --config deploy/attendee-container/wrangler.jsonc",
  "wrangler secret put REDIS_URL --config deploy/attendee-container/wrangler.jsonc",
  "python .attendee/upstream/init_env.py",
  "wrangler secret put DJANGO_SECRET_KEY --config deploy/attendee-container/wrangler.jsonc",
  "wrangler secret put CREDENTIALS_ENCRYPTION_KEY --config deploy/attendee-container/wrangler.jsonc",
  "pnpm attendee:deploy"
];

console.log("minutesbot Cloudflare setup checklist\n");
for (const command of commands) console.log(`- ${command}`);
console.log("\nUse pnpm deploy:oneshot --env production for first-time Cloudflare-first deployments.");
console.log("Use pnpm run deploy for later minutesbot-only deployments so Cloudflare queues are checked before Wrangler runs.");
console.log("Use pnpm attendee:deploy only after configuring external Postgres, Redis, and generated Attendee secrets.");
console.log("Also configure Email Routing for notetaker@minutes.bot and custom domains for app.minutes.bot plus the Attendee host.");
console.log("The main Worker custom domain is app.minutes.bot; keep Attendee on a separate host such as attendee.company.com.");
