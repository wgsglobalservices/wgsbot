import { useEffect, useState } from "react";
import { defaultSettings } from "@minutesbot/shared";
import {
  AuditLogTable,
  auditLogColumns,
  moveAuditLogColumn,
  normalizeAuditLogColumnOrder,
  type AuditLogColumnKey,
  type AuditLogRowOrder
} from "../components/AuditLogTable";
import { apiGet, getSettings } from "../lib/api";

const AUDIT_LOG_COLUMN_ORDER_STORAGE_KEY = "minutesbot.auditLogColumnOrder";
const AUDIT_LOG_ROW_ORDER_STORAGE_KEY = "minutesbot.auditLogRowOrder";
const defaultAuditLogColumnOrder = auditLogColumns.map((column) => column.key);
const auditLogColumnLabels = new Map(auditLogColumns.map((column) => [column.key, column.label]));

export function Logs() {
  const [eventType, setEventType] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  const [timeZone, setTimeZone] = useState(defaultSettings.timeZone);
  const [columnOrder, setColumnOrder] = useState<AuditLogColumnKey[]>(loadAuditLogColumnOrder);
  const [rowOrder, setRowOrder] = useState<AuditLogRowOrder>(loadAuditLogRowOrder);
  const load = () => {
    const params = new URLSearchParams();
    if (eventType) params.set("eventType", eventType);
    if (resourceId) params.set("resourceId", resourceId);
    apiGet<{ auditLogs: Array<Record<string, unknown>> }>(`/api/admin/audit-logs?${params}`).then((data) => setLogs(data.auditLogs));
  };
  useEffect(() => {
    load();
    getSettings().then((settings) => setTimeZone(settings.timeZone)).catch(() => {});
  }, []);

  function updateColumnOrder(nextOrder: AuditLogColumnKey[]) {
    const normalizedOrder = normalizeAuditLogColumnOrder(nextOrder);
    setColumnOrder(normalizedOrder);
    window.localStorage.setItem(AUDIT_LOG_COLUMN_ORDER_STORAGE_KEY, JSON.stringify(normalizedOrder));
  }

  function updateRowOrder(nextOrder: AuditLogRowOrder) {
    setRowOrder(nextOrder);
    window.localStorage.setItem(AUDIT_LOG_ROW_ORDER_STORAGE_KEY, nextOrder);
  }

  return (
    <div className="page logsPage">
      <header><h1>Audit logs</h1><p>Critical invite, bot, transcript, summary, email, artifact, and cleanup events.</p></header>
      <div className="filters logFilters">
        <input placeholder="Event type" value={eventType} onChange={(event) => setEventType(event.target.value)} />
        <input placeholder="Resource ID" value={resourceId} onChange={(event) => setResourceId(event.target.value)} />
        <button onClick={load}>Filter</button>
      </div>
      <section className="logDisplayControls" aria-label="Audit log display controls">
        <label className="logControlGroup" htmlFor="audit-log-row-order">
          <span>Row order</span>
          <select id="audit-log-row-order" value={rowOrder} onChange={(event) => updateRowOrder(event.target.value as AuditLogRowOrder)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <div className="logColumnOrder">
          <div className="logColumnOrderHeader">
            <span>Column order</span>
            <button type="button" className="tertiaryButton compactButton" onClick={() => updateColumnOrder(defaultAuditLogColumnOrder)}>
              Reset
            </button>
          </div>
          <div className="logColumnChips">
            {columnOrder.map((columnKey, index) => {
              const label = auditLogColumnLabels.get(columnKey) ?? columnKey;
              return (
                <div className="logColumnChip" key={columnKey}>
                  <button
                    type="button"
                    className="columnMoveButton"
                    aria-label={`Move ${label} left`}
                    title={`Move ${label} left`}
                    disabled={index === 0}
                    onClick={() => updateColumnOrder(moveAuditLogColumn(columnOrder, columnKey, "left"))}
                  >
                    &lt;
                  </button>
                  <span>{label}</span>
                  <button
                    type="button"
                    className="columnMoveButton"
                    aria-label={`Move ${label} right`}
                    title={`Move ${label} right`}
                    disabled={index === columnOrder.length - 1}
                    onClick={() => updateColumnOrder(moveAuditLogColumn(columnOrder, columnKey, "right"))}
                  >
                    &gt;
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </section>
      <AuditLogTable logs={logs} timeZone={timeZone} columnOrder={columnOrder} rowOrder={rowOrder} />
    </div>
  );
}

function loadAuditLogColumnOrder(): AuditLogColumnKey[] {
  if (typeof window === "undefined") return defaultAuditLogColumnOrder;
  try {
    const stored = JSON.parse(window.localStorage.getItem(AUDIT_LOG_COLUMN_ORDER_STORAGE_KEY) ?? "[]") as string[];
    return normalizeAuditLogColumnOrder(stored);
  } catch {
    return defaultAuditLogColumnOrder;
  }
}

function loadAuditLogRowOrder(): AuditLogRowOrder {
  if (typeof window === "undefined") return "newest";
  return window.localStorage.getItem(AUDIT_LOG_ROW_ORDER_STORAGE_KEY) === "oldest" ? "oldest" : "newest";
}
