import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobRow } from "../lib/types";
import { JobsTable, isRequeueableJobStatus } from "./JobsTable";

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "job_1",
    type: "transcribe",
    idempotency_key: "transcribe:occ_1",
    owner_type: "occurrence",
    owner_id: "occ_1",
    status: "dead_letter",
    attempts: 5,
    max_attempts: 5,
    next_run_at: "2026-06-12T12:00:00.000Z",
    lease_id: null,
    lease_expires_at: null,
    payload: null,
    last_error: "provider timeout",
    created_at: "2026-06-12T10:00:00.000Z",
    updated_at: "2026-06-12T11:00:00.000Z",
    ...overrides
  };
}

describe("isRequeueableJobStatus", () => {
  it("allows requeueing only dead_letter and failed_terminal jobs", () => {
    expect(isRequeueableJobStatus("dead_letter")).toBe(true);
    expect(isRequeueableJobStatus("failed_terminal")).toBe(true);
    expect(isRequeueableJobStatus("pending")).toBe(false);
    expect(isRequeueableJobStatus("leased")).toBe(false);
    expect(isRequeueableJobStatus("completed")).toBe(false);
    expect(isRequeueableJobStatus("failed_retryable")).toBe(false);
    expect(isRequeueableJobStatus("canceled")).toBe(false);
  });
});

describe("jobs table", () => {
  it("renders job rows with owner links and a requeue button for requeueable statuses", () => {
    const html = renderToStaticMarkup(
      React.createElement(JobsTable, {
        jobs: [makeJob(), makeJob({ id: "job_2", status: "pending", last_error: null })],
        onRequeue: () => undefined
      })
    );

    expect(html).toContain("transcribe");
    expect(html).toContain("provider timeout");
    expect(html).toContain('href="#/occurrences/occ_1"');
    expect(html).toContain("badge bad");
    expect((html.match(/Requeue/g) ?? []).length).toBe(1);
  });

  it("omits the actions column when no requeue handler is given", () => {
    const html = renderToStaticMarkup(React.createElement(JobsTable, { jobs: [makeJob()] }));
    expect(html).not.toContain("Requeue");
  });

  it("renders empty state text", () => {
    const html = renderToStaticMarkup(React.createElement(JobsTable, { jobs: [], emptyText: "No jobs." }));
    expect(html).toContain("No jobs.");
  });
});
