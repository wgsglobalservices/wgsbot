import { StatusBadge } from "./StatusBadge";
import { formatDate } from "../lib/dates";

type Meeting = Record<string, string | number | null | undefined>;

type MeetingTableProps = {
  meetings: Meeting[];
  onRemoveMeeting?: (meeting: Meeting) => void;
  deletingMeetingId?: string | null;
};

export function MeetingTable({ meetings, onRemoveMeeting, deletingMeetingId }: MeetingTableProps) {
  return (
    <table>
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
          const id = String(meeting.id ?? "");
          const href = meetingDetailHref(id);
          const isDeleting = deletingMeetingId === id;
          return (
            <tr
              key={id}
              className="clickableRow"
              role="link"
              tabIndex={0}
              onClick={() => openMeeting(id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openMeeting(id);
                }
              }}
              aria-label={`Open ${String(meeting.subject ?? "meeting")}`}
            >
              <td>{formatDate(String(meeting.start_time ?? ""))}</td>
              <td>{meeting.subject}</td>
              <td>{meeting.organizer_email}</td>
              <td><StatusBadge value={String(meeting.status ?? "")} /></td>
              <td>{meeting.attendee_bot_state ?? "not created"}</td>
              <td>{meeting.transcript_status ?? "not_started"}</td>
              <td>{meeting.summary_status ?? "not_started"}</td>
              <td>{meeting.eligible_recipient_count ?? 0}</td>
              <td>{meeting.latest_error ?? ""}</td>
              <td className="actionsCell" onClick={(event) => event.stopPropagation()}>
                <div className="tableActions">
                  <a href={href}>Open</a>
                  {onRemoveMeeting && (
                    <button
                      type="button"
                      className="secondaryButton dangerButton"
                      disabled={isDeleting}
                      onClick={() => onRemoveMeeting(meeting)}
                      aria-label={`Remove ${String(meeting.subject ?? "meeting")} from history`}
                    >
                      {isDeleting ? "Removing" : "Remove"}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function meetingDetailHref(id: string): string {
  return `#/meeting/${encodeURIComponent(id)}`;
}

function openMeeting(id: string): void {
  window.location.hash = meetingDetailHref(id).slice(1);
}
