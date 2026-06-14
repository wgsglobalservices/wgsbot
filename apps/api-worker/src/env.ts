export type QueueBinding<T = unknown> = {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
};

export type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  JOBS_QUEUE: QueueBinding;
  SEND_EMAIL?: { send: (message: unknown) => Promise<unknown> };
  ASSETS?: Fetcher;
  APP_BASE_URL: string;
  API_BASE_URL: string;
  BOT_WEBHOOK_BASE_URL?: string;
  BOT_API_BASE_URL: string;
  BOT_RUNTIME?: Fetcher;
  BOT_INTERNAL_TOKEN?: string;
  DEFAULT_RECORDER_EMAIL?: string;
  DEFAULT_SENDER_EMAIL?: string;
  ENVIRONMENT: string;
  AI_API_KEY?: string;
  TRANSCRIPTION_API_KEY?: string;
  SESSION_SECRET?: string;
  ALLOW_ADMIN_TOKEN_AUTH?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_JWKS_URL?: string;
  CLOUDFLARE_ACCESS_ISSUER?: string;
};
