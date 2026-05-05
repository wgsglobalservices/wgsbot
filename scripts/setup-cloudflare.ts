const commands = [
  "wrangler d1 create minutesbot",
  "wrangler r2 bucket create minutesbot-artifacts",
  "pnpm cloudflare:ensure",
  "wrangler secret put ATTENDEE_API_KEY",
  "wrangler secret put ATTENDEE_WEBHOOK_SECRET",
  "wrangler secret put AI_API_KEY",
  "wrangler secret put SESSION_SECRET",
  "pnpm db:migrate:remote",
  "pnpm run deploy",
  "pnpm deploy:staging",
  "pnpm deploy:production",
  "pnpm attendee:prepare",
  "wrangler secret put DATABASE_URL --config deploy/attendee-container/wrangler.jsonc",
  "wrangler secret put REDIS_URL --config deploy/attendee-container/wrangler.jsonc",
  "wrangler secret put SECRET_KEY --config deploy/attendee-container/wrangler.jsonc",
  "pnpm attendee:deploy"
];

console.log("minutesbot Cloudflare setup checklist\n");
for (const command of commands) console.log(`- ${command}`);
console.log("\nUse pnpm run deploy for minutesbot deployments so Cloudflare queues are checked before Wrangler runs.");
console.log("Use pnpm attendee:deploy only after configuring external Postgres and Redis for Attendee.");
console.log("Also configure Email Routing for notetaker@meet.company.com and custom domains for app/API/attendee hosts.");
console.log("For wgs.bot, change the registrar nameservers to abby.ns.cloudflare.com and arvind.ns.cloudflare.com before expecting traffic to reach Cloudflare.");
