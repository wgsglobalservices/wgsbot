ALTER TABLE meetings ADD COLUMN time_zone TEXT;
ALTER TABLE meetings ADD COLUMN series_uid TEXT;
ALTER TABLE meetings ADD COLUMN occurrence_index INTEGER;
ALTER TABLE meetings ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS meeting_series (
  series_uid TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  organizer_email TEXT NOT NULL,
  organizer_name TEXT,
  teams_join_url TEXT,
  first_start_time TEXT NOT NULL,
  first_end_time TEXT NOT NULL,
  time_zone TEXT,
  recurrence_json TEXT NOT NULL,
  attendees_json TEXT NOT NULL,
  meeting_type TEXT DEFAULT 'general',
  source_recipient TEXT,
  raw_invite_r2_key TEXT,
  raw_invite_size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  expanded_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meetings_series_uid ON meetings(series_uid, start_time);
CREATE INDEX IF NOT EXISTS idx_meeting_series_status ON meeting_series(status, updated_at);
