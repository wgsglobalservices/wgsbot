const commands = [
  "wrangler d1 create minutesbot",
  "wrangler r2 bucket create minutesbot-artifacts",
  "pnpm cloudflare:ensure",
  "wrangler secret put ATTENDEE_API_KEY",
  "wrangler secret put ATTENDEE_WEBHOOK_SECRET",
  "wrangler secret put AI_API_KEY",
  "wrangler secret put SESSION_SECRET",
  "pnpm db:migrate:remote",
  "pnpm run deploy"
];

console.log("minutesbot Cloudflare setup checklist\n");
for (const command of commands) console.log(`- ${command}`);
console.log("\nUse pnpm run deploy for deployments so Cloudflare queues are checked before Wrangler runs.");
console.log("Also configure Email Routing for notetaker@meet.company.com and custom domains for app/API/attendee hosts.");
