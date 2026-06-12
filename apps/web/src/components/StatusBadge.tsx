export function StatusBadge({ value }: { value?: string | null }) {
  const text = value ?? "unknown";
  const kind = /failed|fatal|rejected|invalid|unavailable/i.test(text) ? "bad" : /ready|sent|complete|scheduled|ok|created|joined|recording|ended|available/i.test(text) ? "good" : "neutral";
  return <span className={`badge ${kind}`}>{text}</span>;
}
