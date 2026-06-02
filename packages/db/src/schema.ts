import type { MeetingStatus, SummaryStatus, TranscriptStatus } from "@minutesbot/shared";

export type SettingRow = { key: string; value: string; updated_at: string };

export type MeetingRow = {
  id: string;
  calendar_uid?: string | null;
  subject?: string | null;
  organizer_email?: string | null;
  organizer_name?: string | null;
  teams_join_url?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  status: MeetingStatus;
  attendee_bot_id?: string | null;
  attendee_bot_state?: string | null;
  attendee_transcription_state?: string | null;
  attendee_recording_state?: string | null;
  attendee_last_event_at?: string | null;
  transcript_status?: TranscriptStatus | null;
  summary_status?: SummaryStatus | null;
  latest_error?: string | null;
  meeting_type?: string | null;
  source_recipient?: string | null;
  created_at: string;
  updated_at: string;
};

export type AttendeeRow = {
  id: string;
  meeting_id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  domain?: string | null;
  summary_eligible: number;
  exclusion_reason?: string | null;
  created_at: string;
};

export type ArtifactRow = {
  id: string;
  meeting_id: string;
  type: string;
  r2_key: string;
  content_type?: string | null;
  size_bytes?: number | null;
  created_at: string;
  deleted_at?: string | null;
};

export type AuditLogRow = {
  id: string;
  actor_email?: string | null;
  event_type: string;
  resource_type?: string | null;
  resource_id?: string | null;
  metadata?: string | null;
  created_at: string;
};

export type WebhookEventRow = {
  id: string;
  idempotency_key?: string | null;
  meeting_id?: string | null;
  attendee_bot_id?: string | null;
  trigger: string;
  event_type?: string | null;
  event_sub_type?: string | null;
  payload: string;
  processed_at?: string | null;
  created_at: string;
};

export type TranscriptSegmentRow = {
  id: string;
  meeting_id: string;
  attendee_bot_id?: string | null;
  speaker_name?: string | null;
  speaker_uuid?: string | null;
  speaker_user_uuid?: string | null;
  timestamp_ms?: number | null;
  duration_ms?: number | null;
  text: string;
  source: string;
  created_at: string;
};

export type SummaryRow = {
  id: string;
  meeting_id: string;
  r2_key?: string | null;
  summary_json: string;
  model?: string | null;
  created_at: string;
};

export type EmailDeliveryRow = {
  id: string;
  meeting_id: string;
  recipient_email: string;
  type: string;
  status: string;
  provider_message_id?: string | null;
  failure_reason?: string | null;
  created_at: string;
  sent_at?: string | null;
};
