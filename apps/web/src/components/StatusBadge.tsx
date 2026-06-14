export type BadgeTone = "good" | "bad" | "warning" | "active" | "neutral";

/**
 * Explicit tone mapping for every pipeline status: occurrence lifecycle, bot
 * session states, transcript/recap, deliveries, jobs, inbound messages,
 * calendar events, and audit severities. Unknown values fall back to a
 * keyword heuristic so ad-hoc strings (health checks, runtime states) still
 * get a sensible color.
 */
const toneByStatus: Record<string, BadgeTone> = {
  // Occurrence lifecycle
  scheduled: "neutral",
  join_queued: "active",
  in_meeting: "active",
  post_meeting: "active",
  transcribing: "active",
  summarizing: "active",
  sending_recap: "active",
  completed: "good",
  completed_no_eligible_recipients: "warning",
  failed: "bad",
  canceled: "neutral",
  skipped: "neutral",
  // Bot session states
  created: "neutral",
  warming: "active",
  browser_starting: "active",
  prejoin: "active",
  waiting_for_start: "active",
  waiting_room: "warning",
  joined: "active",
  recording: "active",
  stopping: "active",
  uploading: "active",
  post_processing_completed: "good",
  // Transcript / recap / job statuses
  pending: "neutral",
  running: "active",
  leased: "active",
  failed_retryable: "warning",
  failed_terminal: "bad",
  dead_letter: "bad",
  // Email deliveries
  sent: "good",
  skipped_policy: "neutral",
  // Inbound messages
  received: "neutral",
  parsed: "good",
  rejected: "bad",
  ignored: "neutral",
  // Calendar events / health
  active: "good",
  ok: "good",
  ready: "good",
  pass: "good",
  fail: "bad",
  // Audit severities
  info: "neutral",
  warning: "warning",
  error: "bad"
};

export function statusTone(value?: string | null): BadgeTone {
  if (!value) return "neutral";
  const mapped = toneByStatus[value.toLowerCase()];
  if (mapped) return mapped;
  if (/failed|fatal|rejected|invalid|unavailable|error|dead/i.test(value)) return "bad";
  if (/ready|sent|complete|ok|available|healthy|pass/i.test(value)) return "good";
  return "neutral";
}

export function StatusBadge({ value }: { value?: string | null }) {
  const text = value ?? "unknown";
  return <span className={`badge ${statusTone(value)}`}>{text}</span>;
}
