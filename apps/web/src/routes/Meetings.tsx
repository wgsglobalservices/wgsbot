import { useEffect, useState } from "react";
import { MeetingTable } from "../components/MeetingTable";
import { apiDelete, apiGet } from "../lib/api";

type Meeting = Record<string, string | number | null | undefined>;

type RemoveMeetingFromHistoryInput = {
  meeting: Meeting;
  deleteMeeting: (id: string) => Promise<unknown>;
  setMeetings: (updater: (current: Meeting[]) => Meeting[]) => void;
  setDeletingId: (id: string | null) => void;
  setError: (message: string) => void;
};

export function Meetings() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadMeetings = () =>
    apiGet<{ meetings: Meeting[] }>("/api/meetings")
      .then((data) => setMeetings(data.meetings))
      .catch((err) => setError(err.message));
  useEffect(() => {
    void loadMeetings();
  }, []);

  async function removeMeeting(meeting: Meeting) {
    await removeMeetingFromHistory({
      meeting,
      deleteMeeting: (id) => apiDelete(`/api/meetings/${encodeURIComponent(id)}`),
      setMeetings,
      setDeletingId,
      setError
    });
  }

  return (
    <div className="page">
      <header><h1>Meetings</h1><p>All meeting records created from Teams calendar invites and forwarded Teams links.</p></header>
      {error && <p className="errorText">{error}</p>}
      <MeetingTable meetings={meetings} onRemoveMeeting={removeMeeting} deletingMeetingId={deletingId} />
    </div>
  );
}

export async function removeMeetingFromHistory({
  meeting,
  deleteMeeting,
  setMeetings,
  setDeletingId,
  setError
}: RemoveMeetingFromHistoryInput): Promise<void> {
  const id = String(meeting.id ?? "");
  if (!id) return;
  setDeletingId(id);
  setError("");
  try {
    await deleteMeeting(id);
    setMeetings((current) => current.filter((item) => String(item.id) !== id));
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to remove meeting");
  } finally {
    setDeletingId(null);
  }
}
