import { BotClient } from "@minutesbot/bot-client";
import type { WorkflowEnv } from "./env";

/**
 * Builds the bot runtime client from worker config, preferring the service
 * binding over public fetch when available.
 */
export function createRuntimeClient(env: WorkflowEnv): BotClient {
  return new BotClient({
    baseUrl: env.BOT_API_BASE_URL,
    internalToken: env.BOT_INTERNAL_TOKEN,
    fetcher: env.BOT_RUNTIME
      ? (((input: RequestInfo | URL, init?: RequestInit) => env.BOT_RUNTIME!.fetch(input as RequestInfo, init)) as typeof fetch)
      : undefined
  });
}

export function recordingUploadUrl(env: WorkflowEnv): string {
  return `${env.BOT_API_BASE_URL.replace(/\/+$/, "")}/internal/recordings`;
}
