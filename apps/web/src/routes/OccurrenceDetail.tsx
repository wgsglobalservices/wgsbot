import { useEffect, useState } from "react";
import { apiGet, apiPost, fetchArtifactBlob } from "../lib/api";
import type { ArtifactRow, OccurrenceDetail as OccurrenceDetailData, OccurrenceRow } from "../lib/types";
import { AttendeeTable } from "../components/AttendeeTable";
import { AuditLogTable } from "../components/AuditLogTable";
import { JobsTable } from "../components/JobsTable";
import { StatusBadge } from "../components/StatusBadge";
import { eventDetailHref } from "../components/EventTable";
import { formatBytes, formatDate, formatDurationSeconds, formatTimeRange, isPastIso } from "../lib/dates";

/** Retry join only makes sense while the meeting window is still open and no bot is active. */
export function canRetryJoin(occurrence: Pick<OccurrenceRow, "status" | "end_time">, nowMs: number = Date.now()): boolean {
  if (isPastIso(occurrence.end_time, nowMs)) return false;
  return occurrence.status !== "join_queued" && occurrence.status !== "in_meeting";
}

export function canCancelBot(occurrence: Pick<OccurrenceRow, "status">): boolean {
  return occurrence.status === "join_queued" || occurrence.status === "in_meeting";
}

export function OccurrenceDetail({ id }: { id: string }) {
  const [data, setData] = useState<OccurrenceDetailData | null>(null);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = () => {
    setError("");
    return apiGet<OccurrenceDetailData>(`/api/occurrences/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load occurrence."));
  };

  useEffect(() => {
    setData(null);
    setActionMessage("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function runAction(action: string, label: string) {
    setBusyAction(action);
    setActionMessage("");
    try {
      const result = await apiPost<{ ok: boolean; jobId?: string | null }>(`/api/occurrences/${encodeURIComponent(id)}/${action}`);
      setActionMessage(result.jobId ? `${label} queued (job ${result.jobId}).` : `${label} requested.`);
      await load();
    } catch (actionError) {
      setActionMessage(actionError instanceof Error ? actionError.message : `${label} failed.`);
    } finally {
      setBusyAction(null);
    }
  }

  if (error && !data) return <div className="page"><p className="errorText">{error}</p></div>;
  if (!data) return <div className="page"><p className="mutedText">Loading occurrence...</p></div>;

  const { occurrence, event, botSessions, latestSessionEvents, attendees, transcript, recap, deliveries, artifacts, jobs, auditLogs } = data;
  const meetingOver = isPastIso(occurrence.end_time);

  return (
    <div className="page">
      <header>
        <p>
          <a href="#/meetings">← Meetings</a>
          {event && <> / <a href={eventDetailHref(event.id)}>{event.subject ?? "series"}</a></>}
        </p>
        <h1>{occurrence.subject ?? event?.subject ?? "(no subject)"}</h1>
        <div className="chipRow">
          <StatusBadge value={occurrence.status} />
          {occurrence.is_override ? <span className="badge warning">override</span> : null}
          <span className="mutedText">{formatTimeRange(occurrence.start_time, occurrence.end_time)}</span>
        </div>
      </header>

      {error && <p className="errorText">{error}</p>}

      <section>
        <div className="metricGrid">
          <Metric label="Scheduled join" value={formatDate(occurrence.scheduled_join_time)} />
          <Metric label="Join attempts" value={String(occurrence.join_attempts)} />
          <Metric label="Occurrence key" value={occurrence.occurrence_key} />
          <Metric label="Updated" value={formatDate(occurrence.updated_at)} />
        </div>
        {occurrence.last_error && (
          <div className="errorPanel">
            <strong>Last error</strong>
            <p>{occurrence.last_error}</p>
          </div>
        )}
      </section>

      <section>
        <h2>Actions</h2>
        <div className="detailActions">
          <button
            type="button"
            className="secondaryButton"
            disabled={busyAction !== null || !canRetryJoin(occurrence)}
            title={meetingOver ? "The meeting window has passed; a bot can no longer join." : undefined}
            onClick={() => runAction("retry-join", "Retry join")}
          >
            {busyAction === "retry-join" ? "Working..." : "Retry join"}
          </button>
          <button type="button" className="secondaryButton" disabled={busyAction !== null} onClick={() => runAction("retry-transcription", "Retry transcription")}>
            {busyAction === "retry-transcription" ? "Working..." : "Retry transcription"}
          </button>
          <button type="button" className="secondaryButton" disabled={busyAction !== null} onClick={() => runAction("retry-recap", "Retry recap")}>
            {busyAction === "retry-recap" ? "Working..." : "Retry recap"}
          </button>
          <button
            type="button"
            className="secondaryButton"
            disabled={busyAction !== null || recap?.status !== "completed"}
            title={recap?.status !== "completed" ? "Generate a recap before retrying delivery." : undefined}
            onClick={() => runAction("retry-delivery", "Retry delivery")}
          >
            {busyAction === "retry-delivery" ? "Working..." : "Retry delivery"}
          </button>
          <button
            type="button"
            className="secondaryButton dangerButton"
            disabled={busyAction !== null || !canCancelBot(occurrence)}
            onClick={() => runAction("cancel-bot", "Cancel bot")}
          >
            {busyAction === "cancel-bot" ? "Working..." : "Cancel bot"}
          </button>
        </div>
        {actionMessage && <p className="mutedText" role="status">{actionMessage}</p>}
      </section>

      <section>
        <h2>Bot sessions</h2>
        {botSessions.length === 0 ? (
          <p className="mutedText">No bot sessions yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>State</th><th>Attempt</th><th>Active</th><th>Heartbeat</th><th>Failure stage</th><th>Failure reason</th><th>Started</th><th>Stopped</th></tr>
            </thead>
            <tbody>
              {botSessions.map((session) => (
                <tr key={session.id}>
                  <td><StatusBadge value={session.state} /></td>
                  <td>{session.join_attempt}</td>
                  <td>{session.is_active ? "yes" : "no"}</td>
                  <td className="timeCell">{formatDate(session.last_heartbeat_at)}</td>
                  <td>{session.failure_stage ?? ""}</td>
                  <td>{session.failure_reason ?? ""}</td>
                  <td className="timeCell">{formatDate(session.started_at)}</td>
                  <td className="timeCell">{formatDate(session.stopped_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {latestSessionEvents.length > 0 && (
          <>
            <h2>Latest session events</h2>
            <table className="compactTable">
              <thead>
                <tr><th>Received</th><th>Event</th><th>State</th></tr>
              </thead>
              <tbody>
                {latestSessionEvents.map((sessionEvent) => (
                  <tr key={sessionEvent.id}>
                    <td className="timeCell">{formatDate(sessionEvent.received_at)}</td>
                    <td>{sessionEvent.event_type}</td>
                    <td>{sessionEvent.state ? <StatusBadge value={sessionEvent.state} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section>
        <h2>Transcript & recap</h2>
        <div className="statusCardGrid">
          <div className="statusCard">
            <h3>Transcript {transcript ? <StatusBadge value={transcript.status} /> : <span className="badge neutral">not started</span>}</h3>
            {transcript && (
              <dl>
                <dt>Provider</dt><dd>{transcript.provider ?? "—"}</dd>
                <dt>Model</dt><dd>{transcript.model ?? "—"}</dd>
                <dt>Language</dt><dd>{transcript.language ?? "—"}</dd>
                <dt>Duration</dt><dd>{formatDurationSeconds(transcript.duration_seconds)}</dd>
                <dt>Attempts</dt><dd>{transcript.attempts}</dd>
                {transcript.last_error && <><dt>Last error</dt><dd className="errorText">{transcript.last_error}</dd></>}
              </dl>
            )}
          </div>
          <div className="statusCard">
            <h3>Recap {recap ? <StatusBadge value={recap.status} /> : <span className="badge neutral">not started</span>}</h3>
            {recap && (
              <dl>
                <dt>Provider</dt><dd>{recap.provider ?? "—"}</dd>
                <dt>Model</dt><dd>{recap.model ?? "—"}</dd>
                <dt>Attempts</dt><dd>{recap.attempts}</dd>
                {recap.last_error && <><dt>Last error</dt><dd className="errorText">{recap.last_error}</dd></>}
              </dl>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2>Deliveries</h2>
        {deliveries.length === 0 ? (
          <p className="mutedText">No recap deliveries yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Recipient</th><th>Status</th><th>Provider message ID</th><th>Error</th><th>Sent</th></tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>{delivery.recipient_email}</td>
                  <td><StatusBadge value={delivery.status} /></td>
                  <td>{delivery.provider_message_id ?? ""}</td>
                  <td>{delivery.error ?? ""}</td>
                  <td className="timeCell">{formatDate(delivery.sent_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Attendees & recap eligibility</h2>
        <AttendeeTable attendees={attendees} />
      </section>

      <section>
        <h2>Artifacts</h2>
        <ArtifactsTable artifacts={artifacts} />
      </section>

      <section>
        <h2>Jobs</h2>
        <JobsTable jobs={jobs} emptyText="No jobs recorded for this occurrence." />
      </section>

      <section>
        <h2>Audit log</h2>
        <AuditLogTable logs={auditLogs} timeZone={event?.time_zone ?? "UTC"} />
      </section>
    </div>
  );
}

function ArtifactsTable({ artifacts }: { artifacts: ArtifactRow[] }) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState("");

  if (artifacts.length === 0) return <p className="mutedText">No artifacts stored.</p>;

  async function download(artifact: ArtifactRow) {
    setDownloadingId(artifact.id);
    setDownloadError("");
    try {
      const blob = await fetchArtifactBlob(artifact.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.r2_key.split("/").pop() ?? artifact.id;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Download failed.");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <>
      {downloadError && <p className="errorText">{downloadError}</p>}
      <table>
        <thead>
          <tr><th>Kind</th><th>Content type</th><th>Size</th><th>Created</th><th>Path</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr key={artifact.id} className={artifact.deleted_at ? "mutedRow" : undefined}>
              <td><span className="artifactType">{artifact.kind}</span></td>
              <td>{artifact.content_type ?? ""}</td>
              <td>{formatBytes(artifact.size_bytes)}</td>
              <td className="timeCell">{formatDate(artifact.created_at)}</td>
              <td className="pathCell"><code>{artifact.r2_key}</code></td>
              <td className="actionsCell">
                <button
                  type="button"
                  className="secondaryButton"
                  disabled={downloadingId === artifact.id || Boolean(artifact.deleted_at)}
                  onClick={() => download(artifact)}
                >
                  {downloadingId === artifact.id ? "Downloading..." : "Download"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
