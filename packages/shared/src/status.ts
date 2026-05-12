export type MeetingStatus =
  | "INVITE_RECEIVED"
  | "SCHEDULED"
  | "CANCELLED"
  | "REJECTED_INVALID_RECIPIENT"
  | "REJECTED_EXTERNAL_ORGANIZER"
  | "REJECTED_NO_TEAMS_LINK"
  | "REJECTED_PARSE_ERROR"
  | "REJECTED_UNAUTHENTICATED_SENDER"
  | "REJECTED_NO_ELIGIBLE_RECIPIENTS"
  | "WAITING_TO_CREATE_BOT"
  | "BOT_CREATE_QUEUED"
  | "BOT_CREATED"
  | "BOT_JOINING"
  | "BOT_WAITING_ROOM"
  | "BOT_JOINED"
  | "BOT_RECORDING"
  | "BOT_LEAVING"
  | "BOT_POST_PROCESSING"
  | "BOT_ENDED"
  | "BOT_FATAL_ERROR"
  | "TRANSCRIPT_AVAILABLE"
  | "NO_TRANSCRIPT_AVAILABLE"
  | "SUMMARY_READY"
  | "SUMMARY_SENT"
  | "FAILED";

export type TranscriptStatus = "not_started" | "partial" | "complete" | "unavailable" | "failed";

export type SummaryStatus = "not_started" | "queued" | "generating" | "ready" | "sent" | "failed";

export const auditEventTypes = [
  "settings.changed",
  "invite.received",
  "invite.ignored",
  "invite.rejected",
  "meeting.scheduled",
  "meeting.cancelled",
  "bot.create_queued",
  "bot.created",
  "bot.state_changed",
  "bot.waiting_room",
  "bot.joined",
  "bot.recording",
  "bot.post_processing",
  "bot.ended",
  "bot.fatal_error",
  "transcript.segment_received",
  "transcript.fetch_queued",
  "transcript.recording_pending",
  "transcript.fetched",
  "transcript.unavailable",
  "transcript.failed",
  "summary.queued",
  "summary.generated",
  "summary.sent",
  "summary.failed",
  "email.sent",
  "email.failed",
  "artifact.deleted",
  "attendee.delete_data_called",
  "attendee.data_deleted",
  "cleanup.completed"
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];
