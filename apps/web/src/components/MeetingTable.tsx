import { Fragment } from "react";
import { StatusBadge } from "./StatusBadge";
import { formatDate } from "../lib/dates";
import { isUploadedTranscriptTestMeeting } from "../lib/testMeetings";

type Meeting = Record<string, string | number | null | undefined>;

export function MeetingTable({
  meetings,
  deletingMeetingId = "",
  onDelete,
  now = new Date()
}: {
  meetings: Meeting[];
  deletingMeetingId?: string;
  onDelete?: (id: string) => Promise<void>;
  now?: Date;
}) {
  const openMeeting = (id: string) => {
    window.location.hash = `/meeting/${encodeURIComponent(id)}`;
  };
  const groupedMeetings = groupMeetings(meetings, now);

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
          {groupedMeetings.map((group) =>
            group.meetings.length > 0 ? (
              <Fragment key={group.key}>
                <tr className="meetingGroupRow">
                  <td colSpan={10}>
                    <div className="meetingGroupLabel">
                      <span>{group.label}</span>
                      <span>{group.meetings.length}</span>
                    </div>
                  </td>
                </tr>
                {group.meetings.map((meeting) => {
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
              </Fragment>
            ) : null
          )}
        </tbody>
      </table>
    </div>
  );
}

function groupMeetings(meetings: Meeting[], now: Date): Array<{ key: string; label: string; meetings: Meeting[] }> {
  const nowMs = now.getTime();
  const upcoming = meetings.filter((meeting) => isUpcomingMeeting(meeting, nowMs)).sort(sortByStartAscending);
  const past = meetings.filter((meeting) => !isUpcomingMeeting(meeting, nowMs)).sort(sortByStartDescending);
  return [
    { key: "upcoming", label: "Upcoming meetings", meetings: upcoming },
    { key: "past", label: "Past meetings", meetings: past }
  ];
}

function isUpcomingMeeting(meeting: Meeting, nowMs: number): boolean {
  const endMs = dateValue(meeting.end_time);
  if (endMs !== null) return endMs >= nowMs;
  const startMs = dateValue(meeting.start_time);
  return startMs !== null && startMs >= nowMs;
}

function sortByStartAscending(left: Meeting, right: Meeting): number {
  return compareStartTimes(left, right, "ascending");
}

function sortByStartDescending(left: Meeting, right: Meeting): number {
  return compareStartTimes(left, right, "descending");
}

function compareStartTimes(left: Meeting, right: Meeting, direction: "ascending" | "descending"): number {
  const leftTime = dateValue(left.start_time);
  const rightTime = dateValue(right.start_time);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return direction === "ascending" ? leftTime - rightTime : rightTime - leftTime;
}

function dateValue(value: unknown): number | null {
  if (!value) return null;
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
