// State machines for the occurrence-based pipeline. Every async step persists
// one of these statuses so the admin UI and retry tooling can always tell
// where an item stopped.

export type InboundMessageStatus = "received" | "parsed" | "rejected" | "ignored" | "failed";

export type CalendarEventStatus = "active" | "canceled";

/**
 * Lifecycle of a single meeting occurrence. Recurring series expand into one
 * row per occurrence; each runs this state machine independently.
 */
export type OccurrenceStatus =
  | "scheduled"
  | "join_queued"
  | "in_meeting"
  | "post_meeting"
  | "transcribing"
  | "summarizing"
  | "sending_recap"
  | "completed"
  | "completed_no_eligible_recipients"
  | "failed"
  | "canceled"
  | "skipped";

export const terminalOccurrenceStatuses: OccurrenceStatus[] = [
  "completed",
  "completed_no_eligible_recipients",
  "failed",
  "canceled",
  "skipped"
];

export function isTerminalOccurrenceStatus(status: OccurrenceStatus): boolean {
  return terminalOccurrenceStatuses.includes(status);
}

/** Bot runtime lifecycle states, emitted over signed webhooks. */
export const botSessionStates = [
  "created",
  "warming",
  "browser_starting",
  "prejoin",
  "waiting_for_start",
  "waiting_room",
  "joined",
  "recording",
  "stopping",
  "uploading",
  "post_processing_completed",
  "failed",
  "canceled"
] as const;

export type BotSessionState = (typeof botSessionStates)[number];

export const terminalBotSessionStates: BotSessionState[] = ["post_processing_completed", "failed", "canceled"];

export function isTerminalBotSessionState(state: string | null | undefined): boolean {
  return terminalBotSessionStates.includes(state as BotSessionState);
}

export function isBotSessionState(value: string): value is BotSessionState {
  return (botSessionStates as readonly string[]).includes(value);
}

export type TranscriptStatus = "pending" | "running" | "completed" | "failed_retryable" | "failed_terminal";

export type RecapStatus = "pending" | "running" | "completed" | "failed_retryable" | "failed_terminal";

export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped_policy";

/**
 * Durable job states. `dead_letter` means retries were exhausted;
 * `failed_terminal` means the error was conclusively non-retryable.
 */
export type JobStatus =
  | "pending"
  | "leased"
  | "completed"
  | "failed_retryable"
  | "failed_terminal"
  | "dead_letter"
  | "canceled";

export const jobTypes = [
  "schedule_join",
  "monitor_bot",
  "cancel_bot",
  "transcribe",
  "generate_recap",
  "send_recap",
  "expand_recurrences",
  "retention_cleanup"
] as const;

export type JobType = (typeof jobTypes)[number];

export function isJobType(value: string): value is JobType {
  return (jobTypes as readonly string[]).includes(value);
}

export type ArtifactOwnerType = "inbound_message" | "calendar_event" | "occurrence" | "bot_session" | "settings";

export const artifactKinds = [
  "raw_invite",
  "recording",
  "recording_chunk",
  "transcript_json",
  "transcript_text",
  "summary_json",
  "summary_html",
  "summary_text",
  "screenshot",
  "html_snapshot",
  "console_log",
  "bot_log",
  "diagnostics",
  "bot_event_payload",
  "bot_image"
] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export type AuditSeverity = "info" | "warning" | "error";

export const auditEventTypes = [
  "settings.changed",
  "invite.received",
  "invite.ignored",
  "invite.rejected",
  "event.created",
  "event.updated",
  "event.canceled",
  "occurrence.scheduled",
  "occurrence.updated",
  "occurrence.canceled",
  "occurrence.skipped",
  "occurrence.completed",
  "bot.session_created",
  "bot.started",
  "bot.joined",
  "bot.recording",
  "bot.failed",
  "bot.canceled",
  "bot.stale_recovered",
  "recording.uploaded",
  "transcription.started",
  "transcription.completed",
  "transcription.failed",
  "recap.started",
  "recap.completed",
  "recap.failed",
  "email.delivered",
  "email.failed",
  "email.skipped",
  "artifact.deleted",
  "admin.retry",
  "admin.cancel",
  "admin.delete",
  "job.dead_letter",
  "maintenance.expanded",
  "cleanup.completed"
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];
