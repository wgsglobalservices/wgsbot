export type QueueBinding<T = unknown> = {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
};

export type Env = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  INVITE_QUEUE: QueueBinding;
  SUMMARY_QUEUE: QueueBinding;
  EMAIL_QUEUE: QueueBinding;
  SEND_EMAIL?: { send: (message: unknown) => Promise<unknown> };
  ASSETS?: Fetcher;
  APP_BASE_URL: string;
  API_BASE_URL: string;
  ATTENDEE_WEBHOOK_BASE_URL?: string;
  ATTENDEE_API_BASE_URL: string;
  ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME?: string;
  DEFAULT_RECORDER_EMAIL: string;
  DEFAULT_SENDER_EMAIL: string;
  ENVIRONMENT: string;
  ATTENDEE_API_KEY?: string;
  ATTENDEE_WEBHOOK_SECRET?: string;
  AI_API_KEY?: string;
  EMAIL_API_KEY?: string;
  SMTP_PASSWORD?: string;
  SESSION_SECRET?: string;
};
