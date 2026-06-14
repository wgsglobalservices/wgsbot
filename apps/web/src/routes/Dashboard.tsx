import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import type { JobRow, OccurrenceRow } from "../lib/types";
import { JobsTable } from "../components/JobsTable";
import { OccurrenceTable } from "../components/OccurrenceTable";
import { StatusBadge } from "../components/StatusBadge";

type DashboardData = {
  upcoming: OccurrenceRow[];
  activeSessions: OccurrenceRow[];
  failedJobs: JobRow[];
  recentRecaps: OccurrenceRow[];
  health: { ok: boolean } | null;
  ready: { ready: boolean; checks: Record<string, boolean> } | null;
};

const upcomingWindowDays = 7;

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const now = new Date();
      const to = new Date(now.getTime() + upcomingWindowDays * 24 * 60 * 60 * 1000);
      const [upcoming, joinQueued, inMeeting, deadLetter, failedTerminal, completed, health, ready] = await Promise.all([
        apiGet<{ occurrences: OccurrenceRow[] }>(`/api/occurrences?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
        apiGet<{ occurrences: OccurrenceRow[] }>("/api/occurrences?status=join_queued"),
        apiGet<{ occurrences: OccurrenceRow[] }>("/api/occurrences?status=in_meeting"),
        apiGet<{ jobs: JobRow[] }>("/api/jobs?status=dead_letter"),
        apiGet<{ jobs: JobRow[] }>("/api/jobs?status=failed_terminal"),
        apiGet<{ occurrences: OccurrenceRow[] }>("/api/occurrences?status=completed&limit=500"),
        apiGet<{ ok: boolean }>("/api/health").catch(() => null),
        apiGet<{ ready: boolean; checks: Record<string, boolean> }>("/api/ready").catch(() => null)
      ]);
      setData({
        upcoming: upcoming.occurrences,
        activeSessions: [...joinQueued.occurrences, ...inMeeting.occurrences].sort((a, b) => a.start_time.localeCompare(b.start_time)),
        failedJobs: [...deadLetter.jobs, ...failedTerminal.jobs].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        recentRecaps: completed.occurrences.slice(-10).reverse(),
        health,
        ready
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="page">
      <header>
        <h1>Dashboard</h1>
        <p>Pipeline activity across upcoming occurrences, active bot sessions, and failed jobs.</p>
      </header>
      {error && <p className="errorText">{error}</p>}
      <section>
        <h2>System health</h2>
        <div className="chipRow">
          <StatusBadge value={data?.health?.ok ? "api: ok" : loading ? "api: checking" : "api: unavailable"} />
          <StatusBadge value={data?.ready?.ready ? "ready" : loading ? "ready: checking" : "not ready"} />
          {Object.entries(data?.ready?.checks ?? {}).map(([name, ok]) => (
            <StatusBadge key={name} value={`${name}: ${ok ? "ok" : "failed"}`} />
          ))}
          <BotRuntimeCheckChip />
        </div>
      </section>
      <section>
        <h2>Active bot sessions</h2>
        {loading ? <p className="mutedText">Loading...</p> : <OccurrenceTable occurrences={data?.activeSessions ?? []} emptyText="No bots are queued or in a meeting right now." />}
      </section>
      <section>
        <h2>Upcoming occurrences (next {upcomingWindowDays} days)</h2>
        {loading ? <p className="mutedText">Loading...</p> : <OccurrenceTable occurrences={data?.upcoming ?? []} emptyText="Nothing scheduled in the next 7 days." />}
      </section>
      <section>
        <h2>Failed jobs</h2>
        {loading ? <p className="mutedText">Loading...</p> : <JobsTable jobs={data?.failedJobs ?? []} emptyText="No dead-letter or terminally failed jobs." />}
        {(data?.failedJobs.length ?? 0) > 0 && <p className="mutedText">Requeue jobs from the <a href="#/jobs">Jobs</a> page.</p>}
      </section>
      <section>
        <h2>Recent completed recaps</h2>
        {loading ? <p className="mutedText">Loading...</p> : <OccurrenceTable occurrences={data?.recentRecaps ?? []} emptyText="No completed recaps yet." />}
      </section>
    </div>
  );
}

/** Bot runtime health is checked on demand — it cold-starts the runtime, so no auto-polling. */
function BotRuntimeCheckChip() {
  const [state, setState] = useState<"idle" | "running" | "ok" | "failed">("idle");
  const [message, setMessage] = useState("");
  return (
    <span className="chipRow">
      {state !== "idle" && <StatusBadge value={state === "running" ? "bot runtime: checking" : state === "ok" ? "bot runtime: ok" : "bot runtime: failed"} />}
      <button
        type="button"
        className="tertiaryButton"
        disabled={state === "running"}
        title={message || undefined}
        onClick={async () => {
          setState("running");
          setMessage("");
          try {
            const result = await apiPost<{ ok: boolean }>("/api/admin/test-bot");
            setState(result.ok ? "ok" : "failed");
          } catch (checkError) {
            setState("failed");
            setMessage(checkError instanceof Error ? checkError.message : "Check failed");
          }
        }}
      >
        {state === "running" ? "Checking bot runtime..." : "Check bot runtime"}
      </button>
      {message && <span className="errorText">{message}</span>}
    </span>
  );
}
