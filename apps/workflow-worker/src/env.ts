export type WorkflowEnv = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  INVITE_QUEUE: { send(message: unknown, options?: { delaySeconds?: number }): Promise<void> };
  SUMMARY_QUEUE: { send(message: unknown, options?: { delaySeconds?: number }): Promise<void> };
  EMAIL_QUEUE: { send(message: unknown): Promise<void> };
  ATTENDEE_API_KEY?: string;
  ATTENDEE_API_BASE_URL: string;
  ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME?: string;
  ATTENDEE_WEBHOOK_SECRET?: string;
  ATTENDEE_WEBHOOK_BASE_URL?: string;
  API_BASE_URL: string;
  AI_API_KEY?: string;
  SESSION_SECRET?: string;
  TRANSCRIPT_LINK_SECRET?: string;
  SEND_EMAIL?: { send: (message: unknown) => Promise<unknown> };
  ATTENDEE_FETCHER?: typeof fetch;
};
