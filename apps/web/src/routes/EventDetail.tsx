import { useEffect, useState } from "react";
import { apiDelete, apiGet } from "../lib/api";
import type { EventDetailResponse } from "../lib/types";
import { AttendeeTable } from "../components/AttendeeTable";
import { OccurrenceTable } from "../components/OccurrenceTable";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate } from "../lib/dates";

export function EventDetail({ id }: { id: string }) {
  const [data, setData] = useState<EventDetailResponse | null>(null);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setData(null);
    setError("");
    apiGet<EventDetailResponse>(`/api/events/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load event."));
  }, [id]);

  if (error) return <div className="page"><p className="errorText">{error}</p></div>;
  if (!data) return <div className="page"><p className="mutedText">Loading event...</p></div>;

  const { event, occurrences, attendees, inboundMessages } = data;

  async function deleteEvent() {
    setDeleting(true);
    setError("");
    try {
      await apiDelete(`/api/events/${encodeURIComponent(id)}`);
      window.location.hash = "/meetings";
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete event.");
      setDeleting(false);
    }
  }

  return (
    <div className="page">
      <header>
        <p><a href="#/meetings">← Meetings</a></p>
        <h1>{event.subject ?? "(no subject)"}</h1>
        <div className="chipRow">
          <StatusBadge value={event.status} />
          {event.is_recurring ? <span className="badge active" title={event.rrule ?? undefined}>recurring</span> : <span className="badge neutral">single</span>}
        </div>
      </header>
      <section>
        <h2>Series</h2>
        <div className="metricGrid">
          <Metric label="Organizer" value={event.organizer_name ? `${event.organizer_name} <${event.organizer_email ?? ""}>` : event.organizer_email ?? "Unknown"} />
          <Metric label="ICS UID" value={event.ics_uid} />
          <Metric label="Sequence" value={String(event.sequence)} />
          <Metric label="Time zone" value={event.time_zone ?? "Not set"} />
          <Metric label="RRULE" value={event.rrule ?? "None"} />
          <Metric label="Series start" value={formatDate(event.start_time)} />
          <Metric label="Expanded until" value={formatDate(event.expanded_until)} />
          <Metric label="Teams link" value={event.teams_join_url ? <a href={event.teams_join_url} target="_blank" rel="noreferrer">Join URL</a> : "Not set"} />
        </div>
      </section>
      <section>
        <h2>Occurrences</h2>
        <OccurrenceTable occurrences={occurrences} emptyText="No occurrences expanded for this series yet." />
      </section>
      <section>
        <h2>Attendees & recap eligibility</h2>
        <AttendeeTable attendees={attendees} />
      </section>
      <section>
        <h2>Inbound messages</h2>
        {inboundMessages.length === 0 ? (
          <p className="mutedText">No inbound messages linked to this event.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Received</th><th>From</th><th>Subject</th><th>Method</th><th>Parse status</th><th>Rejection reason</th></tr>
            </thead>
            <tbody>
              {inboundMessages.map((message) => (
                <tr key={message.id}>
                  <td className="timeCell">{formatDate(message.created_at)}</td>
                  <td>{message.from_email ?? ""}</td>
                  <td>{message.subject ?? ""}</td>
                  <td>{message.ics_method ?? ""}</td>
                  <td><StatusBadge value={message.parse_status} /></td>
                  <td>{message.rejection_reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h2>Danger zone</h2>
        <div className="detailActions">
          <button type="button" className="secondaryButton dangerButton" disabled={deleting} onClick={deleteEvent}>
            {deleting ? "Deleting..." : "Delete event and all occurrences"}
          </button>
          <span className="mutedText">Removes the series, its occurrences, artifacts, and queued jobs.</span>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
