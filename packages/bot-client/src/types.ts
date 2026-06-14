import { z } from "zod";
import { botSessionStates, type BotSessionState } from "@minutesbot/shared";

/** Input for POST /v1/bots on the bot runtime. Mirrors the runtime schema exactly. */
export type CreateBotRuntimeInput = {
  /** Caller's session id; used in webhook payloads and idempotency keys. */
  botSessionId: string;
  occurrenceId: string;
  /** Must be a Microsoft Teams join URL; the runtime rejects others with 422. */
  meetingUrl: string;
  displayName: string;
  /** Lobby/meeting-not-started wait budget. */
  joinTimeoutSeconds: number;
  /** Hard recording cap enforced by the runtime. */
  maxDurationSeconds: number;
  recording: { format: "mp3" };
  webhook: { url: string; token: string };
  upload: {
    url: string;
    token: string;
    recordingKey: string;
    chunkKeyPrefix?: string;
    chunkThresholdBytes?: number;
  };
};

export type CreateBotRuntimeResult = {
  runtimeBotId: string;
  state: "created";
};

export type RuntimeBotStatus = {
  runtimeBotId: string;
  botSessionId: string;
  state: BotSessionState;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt: string;
  failureStage?: BotFailureStage;
  failureReason?: string;
};

export type CancelBotResult = {
  runtimeBotId: string;
  botSessionId: string;
  state: BotSessionState;
};

export type BotRuntimeHealthCheck = {
  ok: boolean;
  detail?: string;
};

export type BotRuntimeHealth = {
  ok: boolean;
  version: string;
  containerInstanceId: string;
  checks: {
    chromium: BotRuntimeHealthCheck;
    ffmpeg: BotRuntimeHealthCheck;
    pulseaudio: BotRuntimeHealthCheck;
    tempWritable: BotRuntimeHealthCheck;
    config: BotRuntimeHealthCheck;
  };
};

export type BotRuntimeReadiness = {
  ready: boolean;
  reason?: string;
};

export type BotRuntimeDiagnostics = {
  state: BotSessionState;
  stateHistory: Array<{ state: BotSessionState; at: string }>;
  failureStage?: BotFailureStage;
  failureReason?: string;
  /** Redacted runtime log lines (JSON lines). */
  logTail: string[];
  /** Storage keys of diagnostics uploaded on failure. */
  uploadedDiagnostics: string[];
};

export const botWebhookEventTypes = ["state_change", "heartbeat", "log"] as const;
export type BotWebhookEventType = (typeof botWebhookEventTypes)[number];

export const botFailureStages = [
  "sign_in_required",
  "captcha",
  "admission_denied",
  "meeting_ended",
  "invalid_meeting_url",
  "policy_blocked",
  "browser_launch",
  "navigation",
  "page_load",
  "lobby_timeout",
  "meeting_not_started_timeout",
  "audio_setup",
  "recording",
  "upload",
  "internal"
] as const;
export type BotFailureStage = (typeof botFailureStages)[number];

/**
 * Exact schema for webhook payloads POSTed by the bot runtime. The API worker
 * validates inbound webhooks against this before trusting any field.
 */
export const botWebhookPayloadSchema = z.object({
  /** `${botSessionId}:${eventType}:${state}:${monotonicSeq}` */
  idempotencyKey: z.string().min(1),
  botSessionId: z.string().min(1),
  runtimeBotId: z.string().min(1),
  eventType: z.enum(botWebhookEventTypes),
  state: z.enum(botSessionStates),
  failureStage: z.enum(botFailureStages).optional(),
  failureReason: z.string().optional(),
  recordingKey: z.string().optional(),
  recordingChunkKeys: z.array(z.string()).optional(),
  diagnosticsKeys: z.array(z.string()).optional(),
  timestamp: z.string().datetime()
});

export type BotWebhookPayload = z.infer<typeof botWebhookPayloadSchema>;

export type BotClientOptions = {
  baseUrl: string;
  internalToken?: string;
  fetcher?: typeof fetch;
  /** Per-request timeout; defaults to 30 seconds. */
  timeoutMs?: number;
};
