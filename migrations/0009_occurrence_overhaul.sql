-- Occurrence-based data model overhaul.
--
-- The previous model kept one `meetings` row per calendar UID, which cannot
-- represent recurring series, per-occurrence updates/cancellations, or more
-- than one bot session per meeting. This migration replaces it with:
--   inbound_messages -> calendar_events -> meeting_occurrences -> bot_sessions
-- plus first-class transcripts, recaps, durable jobs, and owner-scoped
-- artifacts. Legacy tables are dropped; this product is pre-1.0 and the
-- pipeline cannot operate on the old shape anyway.

DROP TABLE IF EXISTS attendee_connections;
DROP TABLE IF EXISTS attendee_webhook_events;
DROP TABLE IF EXISTS transcript_segments;
DROP TABLE IF EXISTS summaries;
DROP TABLE IF EXISTS email_deliveries;
DROP TABLE IF EXISTS attendees;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS meetings;
DROP TABLE IF EXISTS allowed_domains;

-- Domain allowlist for recap delivery. Mirrored from settings on save so the
-- send boundary can enforce policy with a single indexed lookup.
CREATE TABLE allowed_domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  allow_subdomains INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Every email the recorder mailbox receives, accepted or not.
CREATE TABLE inbound_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  content_hash TEXT NOT NULL,
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  raw_r2_key TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  rejection_reason TEXT,
  ics_uid TEXT,
  ics_method TEXT,
  ics_sequence INTEGER,
  recurrence_id TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE UNIQUE INDEX idx_inbound_messages_content_hash ON inbound_messages(content_hash);
CREATE INDEX idx_inbound_messages_message_id ON inbound_messages(message_id);
CREATE INDEX idx_inbound_messages_ics_uid ON inbound_messages(ics_uid);
CREATE INDEX idx_inbound_messages_created_at ON inbound_messages(created_at);

-- One row per calendar series (or one-off meeting), keyed by ICS UID.
CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  ics_uid TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL DEFAULT 0,
  organizer_email TEXT,
  organizer_name TEXT,
  subject TEXT,
  teams_join_url TEXT,
  start_time TEXT,
  end_time TEXT,
  time_zone TEXT,
  start_wall_clock TEXT,
  rrule TEXT,
  rdates TEXT,
  exdates TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  expanded_until TEXT,
  last_inbound_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_calendar_events_status ON calendar_events(status, start_time);

-- One row per concrete occurrence; each has its own state machine and bot
-- sessions. occurrence_key is the original scheduled start in UTC basic
-- format (matches ICS RECURRENCE-ID semantics).
CREATE TABLE meeting_occurrences (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  recurrence_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  is_override INTEGER NOT NULL DEFAULT 0,
  subject TEXT,
  teams_join_url TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_join_time TEXT,
  latest_bot_session_id TEXT,
  join_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  canceled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES calendar_events(id)
);

CREATE UNIQUE INDEX idx_occurrences_event_key ON meeting_occurrences(event_id, occurrence_key);
CREATE INDEX idx_occurrences_status_start ON meeting_occurrences(status, start_time);
CREATE INDEX idx_occurrences_start_time ON meeting_occurrences(start_time);

-- Attendees attach to the series; an occurrence override carries its own
-- list via occurrence_id.
CREATE TABLE attendees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  occurrence_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT,
  domain TEXT,
  is_external INTEGER NOT NULL DEFAULT 0,
  recipient_eligible INTEGER NOT NULL DEFAULT 0,
  exclusion_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES calendar_events(id)
);

CREATE INDEX idx_attendees_event_id ON attendees(event_id, occurrence_id);

-- One row per bot runtime session. An occurrence may have several after
-- retries, but at most one non-terminal session (enforced in code via the
-- partial index below).
CREATE TABLE bot_sessions (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  runtime_bot_id TEXT,
  state TEXT NOT NULL DEFAULT 'created',
  is_active INTEGER NOT NULL DEFAULT 1,
  join_attempt INTEGER NOT NULL DEFAULT 1,
  last_heartbeat_at TEXT,
  failure_stage TEXT,
  failure_reason TEXT,
  recording_r2_key TEXT,
  started_at TEXT,
  stopped_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (occurrence_id) REFERENCES meeting_occurrences(id)
);

-- Race-free duplicate-session guard: only one active session per occurrence.
CREATE UNIQUE INDEX idx_bot_sessions_active ON bot_sessions(occurrence_id) WHERE is_active = 1;
CREATE INDEX idx_bot_sessions_runtime_id ON bot_sessions(runtime_bot_id);
CREATE INDEX idx_bot_sessions_heartbeat ON bot_sessions(is_active, last_heartbeat_at);

-- Webhook events from the bot runtime. Payloads above the inline threshold
-- live in R2 (payload_r2_key); D1 keeps the hash for audit.
CREATE TABLE bot_events (
  id TEXT PRIMARY KEY,
  bot_session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state TEXT,
  payload_hash TEXT,
  payload TEXT,
  payload_r2_key TEXT,
  idempotency_key TEXT UNIQUE,
  received_at TEXT NOT NULL,
  FOREIGN KEY (bot_session_id) REFERENCES bot_sessions(id)
);

CREATE INDEX idx_bot_events_session ON bot_events(bot_session_id, received_at);

-- Pointers to R2 objects. D1 never stores artifact bytes or bodies.
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  deleted_at TEXT
);

CREATE INDEX idx_artifacts_owner ON artifacts(owner_type, owner_id);
CREATE INDEX idx_artifacts_kind_created ON artifacts(kind, created_at);
CREATE INDEX idx_artifacts_expires ON artifacts(expires_at) WHERE expires_at IS NOT NULL;

-- Transcription state per occurrence; text/JSON live in R2 via artifacts.
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT,
  model TEXT,
  language TEXT,
  duration_seconds REAL,
  json_artifact_id TEXT,
  text_artifact_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (occurrence_id) REFERENCES meeting_occurrences(id)
);

-- Recap state per occurrence; bodies live in R2 via artifacts.
CREATE TABLE recaps (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT,
  model TEXT,
  json_artifact_id TEXT,
  html_artifact_id TEXT,
  text_artifact_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (occurrence_id) REFERENCES meeting_occurrences(id)
);

CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  recap_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  FOREIGN KEY (recap_id) REFERENCES recaps(id)
);

CREATE INDEX idx_email_deliveries_recap ON email_deliveries(recap_id);
CREATE INDEX idx_email_deliveries_occurrence ON email_deliveries(occurrence_id);
-- One delivery row per recipient per recap; retries reuse the row.
CREATE UNIQUE INDEX idx_email_deliveries_unique ON email_deliveries(recap_id, recipient_email);

-- Durable job records: the single source of truth for scheduled and async
-- work. Queue messages are delivery hints; the cron sweeper recovers any
-- job whose message was lost or whose lease expired.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  owner_type TEXT,
  owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at TEXT NOT NULL,
  lease_id TEXT,
  lease_expires_at TEXT,
  payload TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_due ON jobs(status, next_run_at);
CREATE INDEX idx_jobs_owner ON jobs(owner_type, owner_id);

-- audit_logs gains a severity column; rebuild to keep the schema declarative.
DROP TABLE IF EXISTS audit_logs;
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_email TEXT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  resource_type TEXT,
  resource_id TEXT,
  message TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_logs_resource_id ON audit_logs(resource_id, created_at);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_event_type ON audit_logs(event_type, created_at);
