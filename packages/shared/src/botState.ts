import type { MeetingStatus } from "./status";

/**
 * Maps a bot runtime lifecycle state (and optional webhook event type) to the
 * meeting status shown in the dashboard. Single source of truth — the
 * webhook processor, force-end action, and bot-creation monitor previously
 * carried diverging copies.
 */
export function mapBotStateToMeetingStatus(state?: string, eventType?: string): MeetingStatus | undefined {
  if (eventType === "post_processing_completed") return "BOT_ENDED";
  if (eventType === "cancelled" || state === "cancelled") return "CANCELLED";
  if (eventType === "cancel_requested" || state === "cancelling") return "BOT_LEAVING";
  if (eventType === "fatal_error") return "BOT_FATAL_ERROR";
  if (!state) return undefined;
  if (state === "failed" || state.includes("fatal") || state.includes("error")) return "BOT_FATAL_ERROR";
  if (state === "prejoin" || state === "joining") return "BOT_JOINING";
  if (state.includes("waiting")) return "BOT_WAITING_ROOM";
  if (state === "joined") return "BOT_JOINED";
  if (state.includes("record")) return "BOT_RECORDING";
  if (state.includes("post_processing")) return "BOT_POST_PROCESSING";
  if (state === "ended") return "BOT_ENDED";
  if (state.includes("leave")) return "BOT_LEAVING";
  return "BOT_CREATED";
}

export function isTerminalBotState(state?: string | null, status?: string | null): boolean {
  if (status && ["CANCELLED", "BOT_ENDED", "SUMMARY_SENT", "BOT_FATAL_ERROR", "FAILED"].includes(status)) return true;
  return state === "ended" || state === "failed" || state === "cancelled";
}
