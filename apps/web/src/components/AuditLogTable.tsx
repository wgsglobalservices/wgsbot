import type { AuditLogRow } from "../lib/types";
import { StatusBadge } from "./StatusBadge";

export function AuditLogTable({ logs, timeZone }: { logs: AuditLogRow[]; timeZone: string }) {
  if (logs.length === 0) return <p className="mutedText">No audit log entries.</p>;
  return (
    <table>
      <thead>
        <tr><th>Time</th><th>Severity</th><th>Event</th><th>Actor</th><th>Resource</th><th>Message</th><th>Metadata</th></tr>
      </thead>
      <tbody>
        {logs.map((log) => {
          const createdAt = log.created_at ?? "";
          return (
            <tr key={log.id}>
              <td className="timeCell" title={createdAt}><time dateTime={createdAt}>{formatAuditLogTime(createdAt, timeZone)}</time></td>
              <td><StatusBadge value={log.severity} /></td>
              <td>{log.event_type}</td>
              <td>{log.actor_email ?? ""}</td>
              <td>{log.resource_type ?? ""}{log.resource_id ? `/${log.resource_id}` : ""}</td>
              <td>{log.message ?? ""}</td>
              <td>{log.metadata ? <code>{log.metadata}</code> : null}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function formatAuditLogTime(iso: string, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "short"
  }).format(date);
}
