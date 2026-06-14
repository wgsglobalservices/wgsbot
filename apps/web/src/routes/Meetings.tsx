import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import type { CalendarEventRow, OccurrenceRow } from "../lib/types";
import { EventTable, groupOccurrencesByEvent, summarizeEventOccurrences, type EventOccurrenceSummary } from "../components/EventTable";

export function Meetings() {
  const [events, setEvents] = useState<CalendarEventRow[]>([]);
  const [summaries, setSummaries] = useState<Record<string, EventOccurrenceSummary>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet<{ events: CalendarEventRow[] }>("/api/events"),
      apiGet<{ occurrences: OccurrenceRow[] }>("/api/occurrences?limit=500")
    ])
      .then(([eventData, occurrenceData]) => {
        setEvents(eventData.events);
        const byEvent = groupOccurrencesByEvent(occurrenceData.occurrences);
        const next: Record<string, EventOccurrenceSummary> = {};
        for (const [eventId, occurrences] of byEvent) next[eventId] = summarizeEventOccurrences(occurrences);
        setSummaries(next);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load meetings."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <header>
        <h1>Meetings</h1>
        <p>Calendar event series created from Teams invites. Each series expands into per-occurrence pipelines.</p>
      </header>
      {error && <p className="errorText">{error}</p>}
      {loading ? <p className="mutedText">Loading meetings...</p> : <EventTable events={events} summaries={summaries} />}
    </div>
  );
}
