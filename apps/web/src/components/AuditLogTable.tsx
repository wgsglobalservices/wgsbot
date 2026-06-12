export function AuditLogTable({ logs, timeZone }: { logs: Array<Record<string, unknown>>; timeZone: string }) {
  return (
    <table>
      <thead><tr><th>Time</th><th>Event</th><th>Actor</th><th>Resource</th><th>Metadata</th></tr></thead>
      <tbody>
        {logs.map((log) => {
          const createdAt = String(log.created_at ?? "");
          return (
            <tr key={String(log.id)}>
              <td className="timeCell" title={createdAt}><time dateTime={createdAt}>{formatAuditLogTime(createdAt, timeZone)}</time></td>
              <td>{String(log.event_type)}</td>
              <td>{String(log.actor_email ?? "")}</td>
              <td>{String(log.resource_type ?? "")}/{String(log.resource_id ?? "")}</td>
              <td><code>{String(log.metadata ?? "")}</code></td>
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
