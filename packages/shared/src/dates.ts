export function nowIso(): string {
  return new Date().toISOString();
}

export function minutesBefore(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

export function minutesAfter(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function botJoinTime(startTimeIso: string, minutesBeforeStart: number): string {
  return minutesBefore(startTimeIso, minutesBeforeStart);
}

export function shouldCreateBotNow(startTimeIso: string | null | undefined, minutesBeforeStart: number, now: Date = new Date()): boolean {
  if (!startTimeIso) return true;
  return new Date(botJoinTime(startTimeIso, minutesBeforeStart)).getTime() <= now.getTime();
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function formatDateTime(iso?: string): string {
  if (!iso) return "Not set";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(iso));
}
