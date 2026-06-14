import type { OccurrenceRow } from "../lib/types";
import { formatTimeRange } from "../lib/dates";
import { StatusBadge } from "./StatusBadge";

export function occurrenceDetailHref(id: string): string {
  return `#/occurrences/${encodeURIComponent(id)}`;
}

function openOccurrence(id: string): void {
  window.location.hash = occurrenceDetailHref(id).slice(1);
}

export function OccurrenceTable({ occurrences, emptyText = "No occurrences." }: { occurrences: OccurrenceRow[]; emptyText?: string }) {
  if (occurrences.length === 0) return <p className="mutedText">{emptyText}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Subject</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Last error</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {occurrences.map((occurrence) => (
          <tr
            key={occurrence.id}
            className="clickableRow"
            role="link"
            tabIndex={0}
            aria-label={`Open occurrence ${occurrence.subject ?? occurrence.id}`}
            onClick={() => openOccurrence(occurrence.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openOccurrence(occurrence.id);
              }
            }}
          >
            <td className="timeCell">{formatTimeRange(occurrence.start_time, occurrence.end_time)}</td>
            <td>
              {occurrence.subject ?? "(no subject)"}
              {occurrence.is_override ? <span className="badge warning" title={occurrence.recurrence_id ?? undefined}> override</span> : null}
            </td>
            <td><StatusBadge value={occurrence.status} /></td>
            <td>{occurrence.join_attempts}</td>
            <td>{occurrence.last_error ?? ""}</td>
            <td className="actionsCell" onClick={(event) => event.stopPropagation()}>
              <a href={occurrenceDetailHref(occurrence.id)}>Open</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
