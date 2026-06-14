export type QueueProducer = { send(message: unknown, options?: { delaySeconds?: number }): Promise<void> };

export type WorkflowEnv = {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  JOBS_QUEUE: QueueProducer;
  /** Optional service binding to the bot container worker; falls back to BOT_API_BASE_URL fetch. */
  BOT_RUNTIME?: Fetcher;
  BOT_API_BASE_URL: string;
  BOT_INTERNAL_TOKEN?: string;
  BOT_WEBHOOK_BASE_URL?: string;
  API_BASE_URL: string;
  APP_BASE_URL?: string;
  AI_API_KEY?: string;
  /** Separate transcription key; falls back to AI_API_KEY. */
  TRANSCRIPTION_API_KEY?: string;
  SESSION_SECRET?: string;
  SEND_EMAIL?: { send: (message: unknown) => Promise<unknown> };
};

export type QueueMessageBody =
  | { type: "run_job"; jobId: string }
  | { type: "sweep_due_jobs" }
  | { type: "enqueue_cancel_bot"; occurrenceId: string; reason?: string };
