import type { JobRow } from "../lib/types";
import { formatDate } from "../lib/dates";
import { occurrenceDetailHref } from "./OccurrenceTable";
import { StatusBadge } from "./StatusBadge";

/** Only exhausted or conclusively failed jobs can be pushed back to pending. */
export function isRequeueableJobStatus(status: string): boolean {
  return status === "dead_letter" || status === "failed_terminal";
}

export function JobsTable({
  jobs,
  requeueingId,
  onRequeue,
  emptyText = "No jobs."
}: {
  jobs: JobRow[];
  requeueingId?: string | null;
  onRequeue?: (job: JobRow) => void;
  emptyText?: string;
}) {
  if (jobs.length === 0) return <p className="mutedText">{emptyText}</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Type</th>
          <th>Status</th>
          <th>Attempts</th>
          <th>Next run</th>
          <th>Owner</th>
          <th>Last error</th>
          <th>Updated</th>
          {onRequeue && <th>Actions</th>}
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id}>
            <td>{job.type}</td>
            <td><StatusBadge value={job.status} /></td>
            <td>{job.attempts}/{job.max_attempts}</td>
            <td className="timeCell">{formatDate(job.next_run_at)}</td>
            <td>
              {job.owner_type === "occurrence" && job.owner_id ? (
                <a href={occurrenceDetailHref(job.owner_id)}>{job.owner_id}</a>
              ) : (
                job.owner_id ?? ""
              )}
            </td>
            <td>{job.last_error ?? ""}</td>
            <td className="timeCell">{formatDate(job.updated_at)}</td>
            {onRequeue && (
              <td className="actionsCell">
                {isRequeueableJobStatus(job.status) && (
                  <button
                    type="button"
                    className="secondaryButton"
                    disabled={requeueingId === job.id}
                    onClick={() => onRequeue(job)}
                  >
                    {requeueingId === job.id ? "Requeueing..." : "Requeue"}
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
