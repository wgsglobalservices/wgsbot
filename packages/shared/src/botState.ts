import type { BotSessionState, OccurrenceStatus } from "./status";

/**
 * Default mapping from a bot session state to the occurrence status shown in
 * the dashboard. Single source of truth for the webhook processor and the
 * join monitor. Orchestration may override the failed mapping when a retry
 * is still possible.
 */
export function mapBotStateToOccurrenceStatus(state: BotSessionState): OccurrenceStatus {
  switch (state) {
    case "created":
    case "warming":
    case "browser_starting":
    case "prejoin":
    case "waiting_for_start":
    case "waiting_room":
      return "join_queued";
    case "joined":
    case "recording":
    case "stopping":
    case "uploading":
      return "in_meeting";
    case "post_processing_completed":
      return "post_meeting";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
  }
}

/**
 * Failure stages that must not be retried as if they were transient: the bot
 * was conclusively blocked by Teams policy or a human decision.
 */
export const nonRetryableJoinFailureStages = [
  "sign_in_required",
  "captcha",
  "admission_denied",
  "meeting_ended",
  "invalid_meeting_url",
  "policy_blocked"
] as const;

export type JoinFailureStage =
  | (typeof nonRetryableJoinFailureStages)[number]
  | "browser_launch"
  | "navigation"
  | "page_load"
  | "lobby_timeout"
  | "meeting_not_started_timeout"
  | "audio_setup"
  | "recording"
  | "upload"
  | "internal";

export function isRetryableJoinFailure(stage: string | null | undefined): boolean {
  if (!stage) return true;
  return !(nonRetryableJoinFailureStages as readonly string[]).includes(stage);
}
