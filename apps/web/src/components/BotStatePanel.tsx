import { StatusBadge } from "./StatusBadge";
import { formatDate } from "../lib/dates";

export function BotStatePanel({ meeting }: { meeting: Record<string, unknown> }) {
  const latestError = typeof meeting.latest_error === "string" && meeting.latest_error.trim() ? meeting.latest_error : "";
  return (
    <section>
      <h2>Meeting bot state</h2>
      <div className="metricGrid">
        <Metric label="Bot ID" value={String(meeting.attendee_bot_id ?? "Not created")} />
        <Metric label="State" value={<StatusBadge value={String(meeting.attendee_bot_state ?? "unknown")} />} />
        <Metric label="Transcription" value={String(meeting.attendee_transcription_state ?? "unknown")} />
        <Metric label="Recording" value={String(meeting.attendee_recording_state ?? "unknown")} />
        <Metric label="Last event" value={meeting.attendee_last_event_at ? formatDate(String(meeting.attendee_last_event_at)) : "No events"} />
      </div>
      {latestError ? (
        <div className="errorPanel">
          <strong>Latest error</strong>
          <p>{latestError}</p>
        </div>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
