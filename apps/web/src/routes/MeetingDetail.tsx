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
  const attendees = (data.attendees as Array<Record<string, unknown>>) ?? [];
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
        <ManualSummaryEmailAction meetingId={id} organizerEmail={String(meeting.organizer_email ?? "")} attendees={attendees} done={load} />
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
      <RecipientEligibilityTable
        attendees={attendees}
        emailDeliveries={(data.emailDeliveries as Array<Record<string, unknown>>) ?? []}
      />
      <AttendeeStatePanel meeting={meeting} />
      {meeting.latest_error ? (
        <section>
          <h2>Latest error</h2>
          <div className="errorPanel">{String(meeting.latest_error)}</div>
        </section>
      ) : null}
      <SummarySection summaryRow={data.summary as Record<string, unknown> | null} />
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

function ManualSummaryEmailAction({
  attendees,
  done,
  meetingId,
  organizerEmail
}: {
  attendees: Array<Record<string, unknown>>;
  done: () => void;
  meetingId: string;
  organizerEmail: string;
}) {
  const recipientOptions = meetingRecapRecipientOptions(organizerEmail, attendees);
  const [recipient, setRecipient] = useState(recipientOptions[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");

  useEffect(() => {
    setRecipient((current) => current || recipientOptions[0] || "");
  }, [recipientOptions.join("|")]);

  return (
    <div className="manualSummarySendAction">
      <label>
        <span>Recap recipient</span>
        <input type="email" list="meeting-recap-recipients" value={recipient} onChange={(event) => setRecipient(event.target.value)} />
      </label>
      <datalist id="meeting-recap-recipients">
        {recipientOptions.map((email) => <option key={email} value={email} />)}
      </datalist>
      <button
        className="secondaryButton"
        type="button"
        disabled={busy || !recipient}
        onClick={async () => {
          setBusy(true);
          try {
            const response = await apiPost<unknown>(`/api/meetings/${meetingId}/send-summary-email`, { to: recipient });
            setResult(JSON.stringify(response, null, 2));
            done();
          } catch (error) {
            setResult(error instanceof Error ? error.message : "Failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Sending..." : "Send recap email"}
      </button>
      {result && <pre>{result}</pre>}
    </div>
  );
}

export function meetingRecapRecipientOptions(organizerEmail: string, attendees: Array<Record<string, unknown>>): string[] {
  return uniqueEmails([organizerEmail, ...attendees.map((attendee) => String(attendee.email ?? ""))]);
}

function uniqueEmails(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));
}

type DisplaySummary = {
  meetingTypeLabel: string;
  meetingNotes: Array<{ heading: string; overview: string; items: Array<{ title: string; detail: string }> }>;
  followUpTasks: Array<{ title: string; description: string; owners: string[]; dueDate: string }>;
  legacySections: Array<{ title: string; items: string[] }>;
};

const meetingTypeLabels: Record<string, string> = {
  weekly_spqrc: "Weekly SPQRC",
  weekly_sales: "Weekly Sales",
  plant_meeting: "Individual Plant Meeting",
  general: "General"
};
const aiDisclaimer = "Generated by AI. Be sure to check for accuracy.";

function SummarySection({ summaryRow }: { summaryRow: Record<string, unknown> | null }) {
  const summary = normalizeSummaryForDisplay(typeof summaryRow?.summary_json === "string" ? summaryRow.summary_json : null);
  if (!summary) return null;
  return (
    <section className="recapCard meetingRecapDetail">
      <div className="sectionHeader">
        <h2>Recap</h2>
        <span className="badge neutral">{summary.meetingTypeLabel}</span>
      </div>
      <p className="aiDisclaimer">Generated by AI. Be sure to check for accuracy.</p>
      {summary.meetingNotes.length > 0 ? (
        <div className="teamsRecap">
          <h3>Meeting notes</h3>
          {summary.meetingNotes.map((note) => (
            <section key={note.heading} className="teamsPreviewBlock teamsNoteBlock">
              <h4>{note.heading}</h4>
              {note.overview ? <p>{note.overview}</p> : null}
              {note.items.map((item) => (
                <div key={`${note.heading}-${item.title}`}>
                  <strong>{item.title}</strong>
                  <p>{item.detail}</p>
                </div>
              ))}
            </section>
          ))}
          <h3>Follow-up tasks</h3>
          {summary.followUpTasks.length > 0 ? (
            summary.followUpTasks.map((task) => (
              <section key={task.title} className="teamsPreviewBlock teamsTaskBlock">
                <strong>{task.title}</strong>
                <p>{task.description} ({formatOwners(task.owners)}) Due: {task.dueDate}</p>
              </section>
            ))
          ) : (
            <p className="mutedText">None</p>
          )}
        </div>
      ) : (
        <div className="teamsRecap">
          {summary.legacySections.map((section) => (
            <section key={section.title}>
              <h3>{section.title}</h3>
              <ul className="compactList">
                {(section.items.length > 0 ? section.items : ["None"]).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

export function normalizeSummaryForDisplay(summaryJson: string | null): DisplaySummary | null {
  if (!summaryJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(summaryJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const summary = parsed as Record<string, unknown>;
  const meetingType = typeof summary.meetingType === "string" ? summary.meetingType : "general";
  const meetingNotes = Array.isArray(summary.meetingNotes) ? summary.meetingNotes.map(normalizeMeetingNote).filter((note) => note.items.length > 0 || note.overview) : [];
  const followUpTasks = Array.isArray(summary.followUpTasks) ? summary.followUpTasks.map(normalizeFollowUpTask) : [];
  return {
    meetingTypeLabel: meetingTypeLabels[meetingType] ?? meetingTypeLabels.general,
    meetingNotes,
    followUpTasks,
    legacySections: normalizeLegacySections(summary)
  };
}

function normalizeMeetingNote(value: unknown): DisplaySummary["meetingNotes"][number] {
  const note = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const overview = String(note.overview ?? "");
  return {
    heading: String(note.heading ?? "Meeting notes:"),
    overview: overview.trim() === aiDisclaimer ? "" : overview,
    items: Array.isArray(note.items) ? note.items.map(normalizeMeetingNoteItem) : []
  };
}

function normalizeMeetingNoteItem(value: unknown): DisplaySummary["meetingNotes"][number]["items"][number] {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    title: String(item.title ?? "Detail:"),
    detail: String(item.detail ?? "")
  };
}

function normalizeFollowUpTask(value: unknown): DisplaySummary["followUpTasks"][number] {
  const task = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    title: String(task.title ?? "Follow-up task:"),
    description: String(task.description ?? ""),
    owners: Array.isArray(task.owners) ? task.owners.map((owner) => String(owner)) : ["Unassigned"],
    dueDate: String(task.dueDate ?? "TBD")
  };
}

function normalizeLegacySections(summary: Record<string, unknown>): DisplaySummary["legacySections"] {
  const sections: DisplaySummary["legacySections"] = [];
  addLegacySection(sections, "Summary", summary.summary);
  addLegacySection(
    sections,
    "Action items",
    Array.isArray(summary.actionItems)
      ? summary.actionItems.map((item) => {
          const action = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return [action.owner, action.task, action.dueDate].filter(Boolean).map(String).join(" - ");
        })
      : []
  );
  addLegacySection(sections, "Decisions", summary.decisions);
  addLegacySection(sections, "Open questions", summary.openQuestions);
  addLegacySection(sections, "Risks", summary.risks);
  addLegacySection(sections, "Follow-ups", summary.followUps);
  return sections;
}

function addLegacySection(sections: DisplaySummary["legacySections"], title: string, items: unknown): void {
  if (Array.isArray(items) && items.length > 0) sections.push({ title, items: items.map(String) });
}

function formatOwners(owners: string[]): string {
  return owners.length > 0 ? owners.join(", ") : "Unassigned";
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
