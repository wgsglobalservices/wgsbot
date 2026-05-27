export const auditLogColumns = [
  { key: "time", label: "Time" },
  { key: "event", label: "Event" },
  { key: "actor", label: "Actor" },
  { key: "resource", label: "Resource" },
  { key: "metadata", label: "Metadata" }
] as const;

export type AuditLogColumnKey = (typeof auditLogColumns)[number]["key"];
export type AuditLogRowOrder = "newest" | "oldest";

const defaultAuditLogColumnOrder = auditLogColumns.map((column) => column.key);
const auditLogColumnKeys = new Set<AuditLogColumnKey>(defaultAuditLogColumnOrder);

export function AuditLogTable({
  logs,
  timeZone,
  columnOrder = defaultAuditLogColumnOrder,
  rowOrder = "newest"
}: {
  logs: Array<Record<string, unknown>>;
  timeZone: string;
  columnOrder?: readonly AuditLogColumnKey[];
  rowOrder?: AuditLogRowOrder;
}) {
  const orderedColumns = normalizeAuditLogColumnOrder(columnOrder);
  const sortedLogs = sortAuditLogs(logs, rowOrder);

  return (
    <div className="auditLogTableWrap tableScroll" role="region" aria-label="Audit logs table" tabIndex={0}>
      <table className="auditLogTable">
        <colgroup>
          {orderedColumns.map((columnKey) => (
            <col key={columnKey} className={`auditLogCol auditLogCol-${columnKey}`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {orderedColumns.map((columnKey) => (
              <th key={columnKey}>{getAuditLogColumnLabel(columnKey)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedLogs.map((log, rowIndex) => (
            <tr key={String(log.id ?? `${log.created_at ?? "audit-log"}-${rowIndex}`)}>
              {orderedColumns.map((columnKey) => (
                <td key={columnKey} className={getAuditLogCellClassName(columnKey)}>
                  {renderAuditLogCell(log, timeZone, columnKey)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function normalizeAuditLogColumnOrder(columnOrder: readonly string[] = []): AuditLogColumnKey[] {
  const ordered = columnOrder.filter((columnKey, index, input): columnKey is AuditLogColumnKey => (
    auditLogColumnKeys.has(columnKey as AuditLogColumnKey) && input.indexOf(columnKey) === index
  ));
  return [
    ...ordered,
    ...defaultAuditLogColumnOrder.filter((columnKey) => !ordered.includes(columnKey))
  ];
}

export function moveAuditLogColumn(
  columnOrder: readonly AuditLogColumnKey[],
  columnKey: AuditLogColumnKey,
  direction: "left" | "right"
): AuditLogColumnKey[] {
  const nextOrder = normalizeAuditLogColumnOrder(columnOrder);
  const index = nextOrder.indexOf(columnKey);
  const offset = direction === "left" ? -1 : 1;
  const targetIndex = index + offset;
  if (index < 0 || targetIndex < 0 || targetIndex >= nextOrder.length) return nextOrder;
  [nextOrder[index], nextOrder[targetIndex]] = [nextOrder[targetIndex], nextOrder[index]];
  return nextOrder;
}

export function sortAuditLogs(logs: Array<Record<string, unknown>>, rowOrder: AuditLogRowOrder): Array<Record<string, unknown>> {
  return [...logs].sort((a, b) => {
    const aTime = getAuditLogTimestamp(a);
    const bTime = getAuditLogTimestamp(b);
    if (aTime === bTime) return 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return rowOrder === "oldest" ? aTime - bTime : bTime - aTime;
  });
}

function getAuditLogColumnLabel(columnKey: AuditLogColumnKey): string {
  return auditLogColumns.find((column) => column.key === columnKey)?.label ?? columnKey;
}

function getAuditLogCellClassName(columnKey: AuditLogColumnKey): string | undefined {
  return columnKey === "time" ? "timeCell" : undefined;
}

function renderAuditLogCell(log: Record<string, unknown>, timeZone: string, columnKey: AuditLogColumnKey) {
  if (columnKey === "time") {
    const createdAt = String(log.created_at ?? "");
    return <time dateTime={createdAt} title={createdAt}>{formatAuditLogTime(createdAt, timeZone)}</time>;
  }
  if (columnKey === "event") return String(log.event_type ?? "");
  if (columnKey === "actor") return String(log.actor_email ?? "");
  if (columnKey === "resource") return `${String(log.resource_type ?? "")}/${String(log.resource_id ?? "")}`;
  return <code>{String(log.metadata ?? "")}</code>;
}

function getAuditLogTimestamp(log: Record<string, unknown>): number {
  return new Date(String(log.created_at ?? "")).getTime();
}

export function formatAuditLogTime(iso: string, timeZone: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
    timeZoneName: "short"
  }).format(date);
}
