export type WorkflowEnv = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  INVITE_QUEUE: { send(message: unknown, options?: { delaySeconds?: number }): Promise<void> };
  SUMMARY_QUEUE: { send(message: unknown, options?: { delaySeconds?: number }): Promise<void> };
  BOT_RUNTIME?: Fetcher;
  BOT_API_BASE_URL: string;
  BOT_RECORDING_BUCKET_NAME?: string;
  BOT_INTERNAL_TOKEN?: string;
  BOT_WEBHOOK_BASE_URL?: string;
  API_BASE_URL: string;
  AI_API_KEY?: string;
  SMTP_PASSWORD?: string;
  SESSION_SECRET?: string;
  SEND_EMAIL?: { send: (message: unknown) => Promise<unknown> };
};
