import { StatusBadge } from "./StatusBadge";
import { formatDate } from "../lib/dates";
import { isUploadedTranscriptTestMeeting } from "../lib/testMeetings";

type Meeting = Record<string, string | number | null | undefined>;

export function MeetingTable({
  meetings,
  deletingMeetingId = "",
  onDelete
}: {
  meetings: Meeting[];
  deletingMeetingId?: string;
  onDelete?: (id: string) => Promise<void>;
}) {
  const openMeeting = (id: string) => {
    window.location.hash = `/meeting/${encodeURIComponent(id)}`;
  };

  return (
    <div className="tableScroll" role="region" aria-label="Meetings table" tabIndex={0}>
      <table className="meetingTable">
        <thead>
          <tr>
            <th>Date</th>
            <th>Subject</th>
            <th>Organizer</th>
            <th>Status</th>
            <th>Bot</th>
            <th>Transcript</th>
            <th>Summary</th>
            <th>Eligible</th>
            <th>Latest error</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((meeting) => {
            const meetingId = String(meeting.id);
            return (
              <tr
                key={meetingId}
                className="clickableRow"
                role="link"
                tabIndex={0}
                aria-label={`Open ${String(meeting.subject ?? "meeting")} details`}
                onClick={() => openMeeting(meetingId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openMeeting(meetingId);
                  }
                }}
              >
                <td>{formatDate(String(meeting.start_time ?? ""))}</td>
                <td>
                  {meeting.subject}
                  {isUploadedTranscriptTestMeeting(meeting) ? <span className="badge neutral inlineBadge">Uploaded transcript test</span> : null}
                </td>
                <td>{meeting.organizer_email}</td>
                <td><StatusBadge value={String(meeting.status ?? "")} /></td>
                <td>{meeting.attendee_bot_state ?? "not created"}</td>
                <td>{meeting.transcript_status ?? "not_started"}</td>
                <td>{meeting.summary_status ?? "not_started"}</td>
                <td>{meeting.eligible_recipient_count ?? 0}</td>
                <td>{meeting.latest_error ?? ""}</td>
                <td className="rowActionsCell" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <div className="rowActions">
                    <a href={`#/meeting/${meetingId}`}>Open</a>
                    {onDelete && (
                      <button
                        className="linkButton dangerAction"
                        type="button"
                        disabled={deletingMeetingId === meetingId}
                        onClick={() => {
                          void onDelete(meetingId);
                        }}
                      >
                        {deletingMeetingId === meetingId ? "Deleting..." : "Delete"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
