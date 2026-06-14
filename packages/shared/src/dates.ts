export function nowIso(): string {
  return new Date().toISOString();
}

export function minutesBefore(iso: string, minutes: number): string {
  const base = new Date(iso).getTime();
  // An unparseable timestamp falls back to "now" instead of throwing a
  // RangeError out of queue consumers.
  if (Number.isNaN(base)) return new Date().toISOString();
  return new Date(base - minutes * 60_000).toISOString();
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function formatDateTime(iso?: string): string {
  if (!iso) return "Not set";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
