import { useEffect, useState } from "react";
import { MeetingTable } from "../components/MeetingTable";
import { apiDelete, apiGet } from "../lib/api";

export function Meetings() {
  const [meetings, setMeetings] = useState<Array<Record<string, string | number | null | undefined>>>([]);
  const [deletingMeetingId, setDeletingMeetingId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    apiGet<{ meetings: Array<Record<string, string | number | null | undefined>> }>("/api/meetings")
      .then((data) => setMeetings(data.meetings))
      .catch((err) => setError(err.message));
  }, []);
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
      {error && <p className="errorText">{error}</p>}
      <MeetingTable meetings={meetings} deletingMeetingId={deletingMeetingId} onDelete={deleteMeeting} />
    </div>
  );
}
