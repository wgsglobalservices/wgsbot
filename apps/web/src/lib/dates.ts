export function formatDate(iso?: string | null): string {
  if (!iso) return "Not set";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** "May 10, 2026, 7:30 AM – 8:00 AM" — end collapses to time-only on the same local day. */
export function formatTimeRange(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return "Not set";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "Invalid date";
  const startText = formatDate(startIso);
  if (!endIso) return startText;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return startText;
  const sameDay = start.toDateString() === end.toDateString();
  const endText = sameDay
    ? new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(end)
    : formatDate(endIso);
  return `${startText} – ${endText}`;
}

export function formatDurationSeconds(seconds?: number | null): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export function isPastIso(iso?: string | null, nowMs: number = Date.now()): boolean {
  if (!iso) return false;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return false;
  return time <= nowMs;
}
