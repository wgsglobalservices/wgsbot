-- Deduplicate meetings sharing a calendar_uid (keep the most recently
-- updated row) so the unique index below can be created, then enforce
-- uniqueness to make upsertMeeting race-free.
DELETE FROM meetings
WHERE calendar_uid IS NOT NULL
  AND rowid NOT IN (
    SELECT rowid FROM (
      SELECT rowid, ROW_NUMBER() OVER (PARTITION BY calendar_uid ORDER BY updated_at DESC, rowid DESC) AS rank
      FROM meetings
      WHERE calendar_uid IS NOT NULL
    )
    WHERE rank = 1
  );

DROP INDEX IF EXISTS idx_meetings_calendar_uid;
CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_calendar_uid ON meetings(calendar_uid) WHERE calendar_uid IS NOT NULL;

-- findMeetingByBot runs on every bot webhook event; without this index it is
-- a full table scan.
CREATE INDEX IF NOT EXISTS idx_meetings_attendee_bot_id ON meetings(attendee_bot_id);

-- listAuditLogs filters by resource_id alone, which the existing composite
-- (resource_type, resource_id) index cannot serve.
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_id ON audit_logs(resource_id, created_at);
