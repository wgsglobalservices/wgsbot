const commands = [
  "wrangler d1 create minutesbot",
  "wrangler r2 bucket create minutesbot-artifacts",
  "pnpm cloudflare:ensure",
  "CLOUDFLARE_API_TOKEN=... pnpm cloudflare:ensure-webhook-bypass",
  "wrangler secret put AI_API_KEY",
  "wrangler secret put SESSION_SECRET",
  "cp .env.oneshot.example .env.oneshot",
  "pnpm deploy:oneshot --env production",
  "pnpm db:migrate:remote",
  "pnpm run deploy",
  "pnpm deploy:staging",
  "pnpm deploy:production",
  "pnpm bot:deploy"
];

console.log("minutesbot Cloudflare setup checklist\n");
for (const command of commands) console.log(`- ${command}`);
console.log("\nUse pnpm deploy:oneshot --env production for first-time Cloudflare-first deployments.");
console.log("Use pnpm run deploy for later minutesbot-only deployments so Cloudflare queues are checked before Wrangler runs.");
console.log("Use pnpm bot:deploy for meeting bot container-only deployments.");
console.log("Also configure Email Routing for notetaker@minutes.bot and custom domains for app.minutes.bot, api.minutes.bot, meeting.minutes.bot, and meeting-api.minutes.bot.");
console.log("The admin UI uses app.minutes.bot; the meeting bot webhook uses meeting.minutes.bot; the meeting bot API uses meeting-api.minutes.bot.");
