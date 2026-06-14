import { useEffect, useState } from "react";
import { auditEventTypes, defaultSettings } from "@minutesbot/shared";
import { AuditLogTable } from "../components/AuditLogTable";
import { apiGet, getSettings } from "../lib/api";
import type { AuditLogRow } from "../lib/types";

export function Logs() {
  const [eventType, setEventType] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [severity, setSeverity] = useState("");
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [timeZone, setTimeZone] = useState(defaultSettings.timeZone);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () => {
    const params = new URLSearchParams();
    if (eventType) params.set("eventType", eventType);
    if (resourceId) params.set("resourceId", resourceId);
    if (severity) params.set("severity", severity);
    setError("");
    setLoading(true);
    apiGet<{ auditLogs: AuditLogRow[] }>(`/api/admin/audit-logs?${params}`)
      .then((data) => setLogs(data.auditLogs ?? []))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load audit logs."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    getSettings().then((view) => setTimeZone(view.settings.timeZone)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <header>
        <h1>Audit logs</h1>
        <p>Invite, occurrence, bot, transcription, recap, email, artifact, and maintenance events.</p>
      </header>
      <div className="filters">
        <input list="audit-event-types" placeholder="Event type" value={eventType} onChange={(event) => setEventType(event.target.value)} />
        <datalist id="audit-event-types">
          {auditEventTypes.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
        <input placeholder="Resource ID" value={resourceId} onChange={(event) => setResourceId(event.target.value)} />
        <select value={severity} onChange={(event) => setSeverity(event.target.value)} aria-label="Filter by severity">
          <option value="">All severities</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
        <button onClick={load}>Filter</button>
      </div>
      {error && <p className="errorText">{error}</p>}
      {loading ? <p className="mutedText">Loading audit logs...</p> : <AuditLogTable logs={logs} timeZone={timeZone} />}
    </div>
  );
}
