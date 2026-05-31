import { useEffect, useState } from "react";
import { MeetingTable } from "../components/MeetingTable";
import { apiDelete, apiGet } from "../lib/api";

const FUTURE_DAY_OPTIONS = [7, 14, 30, 60, 90, 180] as const;

export function Meetings() {
  const [meetings, setMeetings] = useState<Array<Record<string, string | number | null | undefined>>>([]);
  const [deletingMeetingId, setDeletingMeetingId] = useState("");
  const [error, setError] = useState("");
  const [futureDays, setFutureDays] = useState<number>(7);

  useEffect(() => {
    let active = true;
    apiGet<{ meetings: Array<Record<string, string | number | null | undefined>> }>(buildMeetingsPath(futureDays))
      .then((data) => {
        if (active) setMeetings(data.meetings);
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [futureDays]);

  const deleteMeeting = async (id: string) => {
    setDeletingMeetingId(id);
    setError("");
    try {
      await apiDelete(`/api/meetings/${encodeURIComponent(id)}`);
      setMeetings((current) => current.filter((meeting) => String(meeting.id) !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete meeting");
    } finally {
      setDeletingMeetingId("");
    }
  };
  return (
    <div className="page meetingsPage">
      <header><h1>Meetings</h1><p>All meeting records created from Teams calendar invites and forwarded Teams links.</p></header>
      <div className="meetingListControls">
        <label className="meetingFutureWindow">
          <span>Show future</span>
          <select value={futureDays} onChange={(event) => setFutureDays(Number(event.currentTarget.value))}>
            {FUTURE_DAY_OPTIONS.map((days) => (
              <option key={days} value={days}>{days} days</option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="errorText">{error}</p>}
      <MeetingTable meetings={meetings} deletingMeetingId={deletingMeetingId} onDelete={deleteMeeting} />
    </div>
  );
}

export function buildMeetingsPath(futureDays: number): string {
  return `/api/meetings?futureDays=${encodeURIComponent(String(futureDays))}`;
}
