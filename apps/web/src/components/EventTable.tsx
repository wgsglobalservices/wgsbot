import type { CalendarEventRow, OccurrenceRow } from "../lib/types";
import { formatDate } from "../lib/dates";
import { StatusBadge } from "./StatusBadge";

export type EventOccurrenceSummary = { nextStart: string | null; lastStart: string | null };

export function eventDetailHref(id: string): string {
  return `#/events/${encodeURIComponent(id)}`;
}

function openEvent(id: string): void {
  window.location.hash = eventDetailHref(id).slice(1);
}

/** Next upcoming and most recent past occurrence start for one event's occurrences. */
export function summarizeEventOccurrences(occurrences: OccurrenceRow[], nowMs: number = Date.now()): EventOccurrenceSummary {
  let nextStart: string | null = null;
  let lastStart: string | null = null;
  for (const occurrence of occurrences) {
    const startMs = Date.parse(occurrence.start_time);
    if (Number.isNaN(startMs)) continue;
    if (startMs >= nowMs) {
      if (!nextStart || startMs < Date.parse(nextStart)) nextStart = occurrence.start_time;
    } else if (!lastStart || startMs > Date.parse(lastStart)) {
      lastStart = occurrence.start_time;
    }
  }
  return { nextStart, lastStart };
}

export function groupOccurrencesByEvent(occurrences: OccurrenceRow[]): Map<string, OccurrenceRow[]> {
  const byEvent = new Map<string, OccurrenceRow[]>();
  for (const occurrence of occurrences) {
    const list = byEvent.get(occurrence.event_id) ?? [];
    list.push(occurrence);
    byEvent.set(occurrence.event_id, list);
  }
  return byEvent;
}

export function EventTable({
  events,
  summaries = {},
  emptyText = "No calendar events yet. Invite the recorder address to a Teams meeting to get started."
}: {
  events: CalendarEventRow[];
  summaries?: Record<string, EventOccurrenceSummary>;
  emptyText?: string;
}) {
  if (events.length === 0) return <p className="mutedText">{emptyText}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Subject</th>
          <th>Organizer</th>
          <th>Recurrence</th>
          <th>Status</th>
          <th>Next occurrence</th>
          <th>Last occurrence</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => {
          const summary = summaries[event.id];
          return (
            <tr
              key={event.id}
              className="clickableRow"
              role="link"
              tabIndex={0}
              aria-label={`Open ${event.subject ?? "event"}`}
              onClick={() => openEvent(event.id)}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                  keyEvent.preventDefault();
                  openEvent(event.id);
                }
              }}
            >
              <td>{event.subject ?? "(no subject)"}</td>
              <td>{event.organizer_email ?? ""}</td>
              <td>
                {event.is_recurring ? (
                  <span className="badge active" title={event.rrule ?? undefined}>recurring</span>
                ) : (
                  <span className="badge neutral">single</span>
                )}
              </td>
              <td><StatusBadge value={event.status} /></td>
              <td className="timeCell">{summary?.nextStart ? formatDate(summary.nextStart) : "—"}</td>
              <td className="timeCell">{summary?.lastStart ? formatDate(summary.lastStart) : "—"}</td>
              <td className="actionsCell" onClick={(clickEvent) => clickEvent.stopPropagation()}>
                <a href={eventDetailHref(event.id)}>Open</a>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
