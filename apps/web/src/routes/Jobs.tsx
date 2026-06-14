import { useEffect, useState } from "react";
import { jobTypes } from "@minutesbot/shared";
import { apiGet, apiPost } from "../lib/api";
import type { JobRow } from "../lib/types";
import { JobsTable } from "../components/JobsTable";

const jobStatuses = ["pending", "leased", "completed", "failed_retryable", "failed_terminal", "dead_letter", "canceled"] as const;

export function Jobs() {
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [requeueingId, setRequeueingId] = useState<string | null>(null);

  const load = (statusFilter: string, typeFilter: string) => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (typeFilter) params.set("type", typeFilter);
    params.set("limit", "200");
    setLoading(true);
    setError("");
    return apiGet<{ jobs: JobRow[] }>(`/api/jobs?${params}`)
      .then((data) => setJobs(data.jobs))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "Failed to load jobs."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void load(status, type);

  }, [status, type]);

  async function requeue(job: JobRow) {
    setRequeueingId(job.id);
    setMessage("");
    try {
      await apiPost(`/api/jobs/${encodeURIComponent(job.id)}/requeue`);
      setMessage(`Requeued ${job.type} job ${job.id}.`);
      await load(status, type);
    } catch (requeueError) {
      setMessage(requeueError instanceof Error ? requeueError.message : "Requeue failed.");
    } finally {
      setRequeueingId(null);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Jobs</h1>
        <p>Durable pipeline jobs. Dead-letter and terminally failed jobs can be requeued.</p>
      </header>
      <div className="filters">
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {jobStatuses.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Filter by type">
          <option value="">All types</option>
          {jobTypes.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>
      {error && <p className="errorText">{error}</p>}
      {message && <p className="mutedText" role="status">{message}</p>}
      {loading ? <p className="mutedText">Loading jobs...</p> : <JobsTable jobs={jobs} requeueingId={requeueingId} onRequeue={requeue} />}
    </div>
  );
}
