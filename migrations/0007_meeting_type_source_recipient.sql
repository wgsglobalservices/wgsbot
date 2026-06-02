ALTER TABLE meetings ADD COLUMN meeting_type TEXT DEFAULT 'general';
ALTER TABLE meetings ADD COLUMN source_recipient TEXT;

UPDATE meetings SET meeting_type = 'general' WHERE meeting_type IS NULL OR meeting_type = '';

CREATE INDEX IF NOT EXISTS idx_meetings_meeting_type ON meetings(meeting_type);
CREATE INDEX IF NOT EXISTS idx_meetings_source_recipient ON meetings(source_recipient);
