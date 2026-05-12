const commands = [
  "wrangler d1 create minutesbot",
  "wrangler r2 bucket create minutesbot-artifacts",
  "pnpm cloudflare:ensure",
  "CLOUDFLARE_API_TOKEN=... pnpm cloudflare:ensure-webhook-bypass",
  "wrangler secret put ATTENDEE_API_KEY",
  "wrangler secret put ATTENDEE_WEBHOOK_SECRET",
  "wrangler secret put AI_API_KEY",
  "wrangler secret put SESSION_SECRET",
  "wrangler secret put TRANSCRIPT_LINK_SECRET",
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
  "wrangler secret put ATTENDEE_OPS_TOKEN --config deploy/attendee-container/wrangler.jsonc",
  "pnpm attendee:deploy"
];

console.log("minutesbot Cloudflare setup checklist\n");
for (const command of commands) console.log(`- ${command}`);
console.log("\nUse pnpm run deploy for minutesbot deployments so Cloudflare queues are checked before Wrangler runs.");
console.log("Use pnpm attendee:deploy only after configuring external Postgres, Redis, and generated Attendee secrets.");
console.log("Also configure Email Routing for notetaker@meet.company.com and custom domains for app/API/attendee hosts.");
console.log("Production custom domains are minutesbot-admin.wgsglobal.app, minutesbot-api.wgsglobal.app, and minutesbot-webhook.wgsglobal.app. Keep the wgsglobal.app zone delegated to abby.ns.cloudflare.com and arvind.ns.cloudflare.com.");
