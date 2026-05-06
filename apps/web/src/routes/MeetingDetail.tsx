import { useEffect, useState } from "react";
import { AttendeeStatePanel } from "../components/AttendeeStatePanel";
import { RecipientEligibilityTable } from "../components/RecipientEligibilityTable";
import { StatusBadge } from "../components/StatusBadge";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { formatDate } from "../lib/dates";

export function MeetingDetail({ id }: { id: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const load = () => apiGet<Record<string, unknown>>(`/api/meetings/${id}`).then(setData).catch((error) => setMessage(error.message));
  useEffect(() => {
    void load();
  }, [id]);
  if (!data) return <p>{message || "Loading meeting..."}</p>;
  const meeting = data.meeting as Record<string, unknown>;
  return (
    <div className="page">
      <header>
        <h1>{String(meeting.subject ?? "Meeting")}</h1>
        <p>{formatDate(String(meeting.start_time ?? ""))} · <StatusBadge value={String(meeting.status ?? "")} /></p>
      </header>
      <section>
        <h2>Controls</h2>
        <div className="actions">
          <Action label="Retry bot" run={() => apiPost(`/api/meetings/${id}/retry-bot`)} done={load} />
          <Action label="Fetch transcript" run={() => apiPost(`/api/meetings/${id}/fetch-transcript`)} done={load} />
          <Action label="Retry summary" run={() => apiPost(`/api/meetings/${id}/retry-summary`)} done={load} />
          <Action label="Delete artifacts" run={() => apiDelete(`/api/meetings/${id}/artifacts`)} done={load} />
          <Action label="Delete Attendee data" run={() => apiPost(`/api/meetings/${id}/delete-attendee-data`)} done={load} />
        </div>
        {message && <p>{message}</p>}
      </section>
      <section>
        <h2>Meeting metadata</h2>
        <div className="metricGrid">
          <Metric label="Organizer" value={String(meeting.organizer_email ?? "")} />
          <Metric label="Calendar UID" value={String(meeting.calendar_uid ?? "")} />
          <Metric label="Teams join URL" value={String(meeting.teams_join_url ?? "")} />
          <Metric label="Summary status" value={String(meeting.summary_status ?? "")} />
        </div>
      </section>
      <RecipientEligibilityTable attendees={(data.attendees as Array<Record<string, unknown>>) ?? []} />
      <AttendeeStatePanel meeting={meeting} />
      {meeting.latest_error ? (
        <section>
          <h2>Latest error</h2>
          <div className="errorPanel">{String(meeting.latest_error)}</div>
        </section>
      ) : null}
      <TableSection title="Transcript segments" rows={(data.transcriptSegments as Array<Record<string, unknown>>) ?? []} />
      <ArtifactSection rows={(data.artifacts as Array<Record<string, unknown>>) ?? []} />
      <TableSection title="Webhook events" rows={(data.webhookEvents as Array<Record<string, unknown>>) ?? []} />
      <TableSection title="Email deliveries" rows={(data.emailDeliveries as Array<Record<string, unknown>>) ?? []} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Action({ label, run, done }: { label: string; run: () => Promise<unknown>; done: () => void }) {
  return <button onClick={async () => { await run(); done(); }}>{label}</button>;
}

type ArtifactSummary = {
  key: string;
  type: string;
  path: string;
  contentType: string;
  sizeBytes: number | null;
  latestCreatedAt: string;
  count: number;
  deleted: boolean;
};

function ArtifactSection({ rows }: { rows: Array<Record<string, unknown>> }) {
  const artifacts = summarizeArtifacts(rows);
  return (
    <section>
      <div className="sectionHeader">
        <h2>Artifacts</h2>
        {rows.length > 0 && (
          <span className="sectionMeta">
            {artifacts.length} shown from {rows.length} {rows.length === 1 ? "record" : "records"}
          </span>
        )}
      </div>
      <div className="scroll">
        <table className="compactTable">
          <thead>
            <tr>
              <th>Type</th>
              <th>Object</th>
              <th>Format</th>
              <th>Size</th>
              <th>Latest</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((artifact) => (
              <tr key={artifact.key} className={artifact.deleted ? "mutedRow" : undefined}>
                <td>
                  <span className={`artifactType ${artifactWarningClass(artifact)}`}>{artifact.type}</span>
                </td>
                <td className="pathCell" title={artifact.path}>{shortenArtifactPath(artifact.path)}</td>
                <td>{artifact.contentType}</td>
                <td>{formatBytes(artifact.sizeBytes)}</td>
                <td>{formatDate(artifact.latestCreatedAt)}</td>
                <td>{artifact.count > 1 ? `x${artifact.count}` : "1"}</td>
              </tr>
            ))}
            {artifacts.length === 0 && <tr><td colSpan={6}>No records</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function summarizeArtifacts(rows: Array<Record<string, unknown>>): ArtifactSummary[] {
  const groups = new Map<string, ArtifactSummary>();
  for (const row of rows) {
    const type = String(row.type ?? "unknown");
    const path = String(row.r2_key ?? "");
    const contentType = String(row.content_type ?? "unknown");
    const sizeBytes = typeof row.size_bytes === "number" ? row.size_bytes : null;
    const deleted = Boolean(row.deleted_at);
    const key = [type, path, contentType, sizeBytes ?? "", deleted ? "deleted" : "active"].join("|");
    const createdAt = String(row.created_at ?? "");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (createdAt > existing.latestCreatedAt) existing.latestCreatedAt = createdAt;
    } else {
      groups.set(key, { key, type, path, contentType, sizeBytes, latestCreatedAt: createdAt, count: 1, deleted });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.latestCreatedAt.localeCompare(a.latestCreatedAt));
}

function artifactWarningClass(artifact: ArtifactSummary): string {
  return artifact.type === "recording" && artifact.contentType === "application/json" ? "warning" : "";
}

function shortenArtifactPath(path: string): string {
  if (!path) return "-";
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `${parts[0]}/.../${parts.at(-1)}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TableSection({ title, rows }: { title: string; rows: Array<Record<string, unknown>> }) {
  return (
    <section>
      <h2>{title}</h2>
      <div className="scroll">
        <table>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.id ?? index)}>
                <td><pre>{JSON.stringify(row, null, 2)}</pre></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td>No records</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
