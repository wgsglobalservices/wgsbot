import { REQUIRED_ENV_KEYS } from "./deploy-oneshot";

const DEFAULT_VALUES: Partial<Record<(typeof REQUIRED_ENV_KEYS)[number], string>> = {
  CLOUDFLARE_ENV: "production",
  APP_BASE_URL: "https://app.minutes.bot",
  API_BASE_URL: "https://api.minutes.bot",
  BOT_WEBHOOK_BASE_URL: "https://meeting.minutes.bot",
  BOT_API_BASE_URL: "https://meeting-api.minutes.bot",
  BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
  DEFAULT_RECORDER_EMAIL: "notetaker@minutes.bot",
  DEFAULT_SENDER_EMAIL: "notetaker@minutes.bot",
  CLOUDFLARE_ACCESS_JWKS_URL: "https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs"
};

const lines = REQUIRED_ENV_KEYS.map((key) => `${key}=${DEFAULT_VALUES[key] ?? ""}`);

console.log(["# minutesbot Cloudflare Worker", ...lines].join("\n"));
