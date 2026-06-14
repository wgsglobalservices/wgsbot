import type {
  ArtifactKind,
  ArtifactOwnerType,
  AuditSeverity,
  BotSessionState,
  CalendarEventStatus,
  DeliveryStatus,
  InboundMessageStatus,
  JobStatus,
  JobType,
  OccurrenceStatus,
  RecapStatus,
  TranscriptStatus
} from "@minutesbot/shared";

// Row shapes returned by the admin API. Field names mirror the D1 schema
// (snake_case) in packages/db/src/schema.ts.

export type CalendarEventRow = {
  id: string;
  ics_uid: string;
  sequence: number;
  organizer_email: string | null;
  organizer_name: string | null;
  subject: string | null;
  teams_join_url: string | null;
  start_time: string | null;
  end_time: string | null;
  time_zone: string | null;
  start_wall_clock: string | null;
  rrule: string | null;
  rdates: string | null;
  exdates: string | null;
  is_recurring: number;
  status: CalendarEventStatus;
  expanded_until: string | null;
  last_inbound_message_id: string | null;
  created_at: string;
  updated_at: string;
};

export type OccurrenceRow = {
  id: string;
  event_id: string;
  occurrence_key: string;
  recurrence_id: string | null;
  sequence: number;
  is_override: number;
  subject: string | null;
  teams_join_url: string | null;
  start_time: string;
  end_time: string;
  status: OccurrenceStatus;
  scheduled_join_time: string | null;
  latest_bot_session_id: string | null;
  join_attempts: number;
  last_error: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AttendeeRow = {
  id: string;
  event_id: string;
  occurrence_id: string | null;
  email: string;
  name: string | null;
  role: string | null;
  domain: string | null;
  is_external: number;
  recipient_eligible: number;
  exclusion_reason: string | null;
  created_at: string;
};

export type InboundMessageRow = {
  id: string;
  message_id: string | null;
  content_hash: string;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  raw_r2_key: string;
  parse_status: InboundMessageStatus;
  rejection_reason: string | null;
  ics_uid: string | null;
  ics_method: string | null;
  ics_sequence: number | null;
  recurrence_id: string | null;
  event_id: string | null;
  created_at: string;
  processed_at: string | null;
};

export type BotSessionRow = {
  id: string;
  occurrence_id: string;
  runtime_bot_id: string | null;
  state: BotSessionState;
  is_active: number;
  join_attempt: number;
  last_heartbeat_at: string | null;
  failure_stage: string | null;
  failure_reason: string | null;
  recording_r2_key: string | null;
  started_at: string | null;
  stopped_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BotEventRow = {
  id: string;
  bot_session_id: string;
  event_type: string;
  state: string | null;
  payload_hash: string | null;
  payload: string | null;
  payload_r2_key: string | null;
  idempotency_key: string | null;
  received_at: string;
};

export type ArtifactRow = {
  id: string;
  owner_type: ArtifactOwnerType;
  owner_id: string;
  kind: ArtifactKind;
  r2_key: string;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  created_at: string;
  expires_at: string | null;
  deleted_at: string | null;
};

export type TranscriptRow = {
  id: string;
  occurrence_id: string;
  status: TranscriptStatus;
  provider: string | null;
  model: string | null;
  language: string | null;
  duration_seconds: number | null;
  json_artifact_id: string | null;
  text_artifact_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type RecapRow = {
  id: string;
  occurrence_id: string;
  status: RecapStatus;
  provider: string | null;
  model: string | null;
  json_artifact_id: string | null;
  html_artifact_id: string | null;
  text_artifact_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type EmailDeliveryRow = {
  id: string;
  recap_id: string;
  occurrence_id: string;
  recipient_email: string;
  recipient_domain: string;
  status: DeliveryStatus;
  provider_message_id: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

export type JobRow = {
  id: string;
  type: JobType;
  idempotency_key: string;
  owner_type: string | null;
  owner_id: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  lease_id: string | null;
  lease_expires_at: string | null;
  payload: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type AuditLogRow = {
  id: string;
  actor_email: string | null;
  event_type: string;
  severity: AuditSeverity;
  resource_type: string | null;
  resource_id: string | null;
  message: string | null;
  metadata: string | null;
  created_at: string;
};

export type OccurrenceDetail = {
  occurrence: OccurrenceRow;
  event: CalendarEventRow | null;
  botSessions: BotSessionRow[];
  latestSessionEvents: BotEventRow[];
  attendees: AttendeeRow[];
  transcript: TranscriptRow | null;
  recap: RecapRow | null;
  deliveries: EmailDeliveryRow[];
  artifacts: ArtifactRow[];
  jobs: JobRow[];
  auditLogs: AuditLogRow[];
};

export type EventDetailResponse = {
  event: CalendarEventRow;
  occurrences: OccurrenceRow[];
  attendees: AttendeeRow[];
  inboundMessages: InboundMessageRow[];
};
