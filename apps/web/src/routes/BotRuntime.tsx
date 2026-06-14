import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../lib/api";
import type { AuditLogRow } from "../lib/types";
import { AuditLogTable } from "../components/AuditLogTable";
import { StatusBadge } from "../components/StatusBadge";

type AdminStatus = {
  environment?: string;
  apiBaseUrl?: string;
  appBaseUrl?: string;
  botRuntime?: { baseUrl?: string; viaServiceBinding?: boolean };
};

type BotHealthResult = { ok: boolean; health?: unknown; ready?: unknown };

/** Flattens nested health/ready payloads into label → value chips. */
export function flattenChecks(value: unknown, prefix = ""): Array<{ label: string; value: string; ok: boolean | null }> {
  if (value === null || value === undefined) return [];
  if (typeof value === "boolean") return [{ label: prefix || "ok", value: value ? "ok" : "failed", ok: value }];
  if (typeof value === "string" || typeof value === "number") {
    return [{ label: prefix || "value", value: String(value), ok: null }];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenChecks(item, prefix ? `${prefix}.${index}` : String(index)));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      flattenChecks(entry, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [];
}

export function BotRuntime() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [check, setCheck] = useState<BotHealthResult | null>(null);
  const [checkError, setCheckError] = useState("");
  const [checking, setChecking] = useState(false);
  const [failures, setFailures] = useState<AuditLogRow[]>([]);
  const [failuresError, setFailuresError] = useState("");

  useEffect(() => {
    apiGet<AdminStatus>("/api/admin/status")
      .then(setStatus)
      .catch((error) => setStatusError(error instanceof Error ? error.message : "Failed to load status."));
    apiGet<{ auditLogs: AuditLogRow[] }>("/api/admin/audit-logs?eventType=bot.failed&limit=50")
      .then((data) => setFailures(data.auditLogs))
      .catch((error) => setFailuresError(error instanceof Error ? error.message : "Failed to load bot failures."));
  }, []);

  async function runHealthCheck() {
    setChecking(true);
    setCheckError("");
    try {
      setCheck(await apiPost<BotHealthResult>("/api/admin/test-bot"));
    } catch (error) {
      setCheck(null);
      setCheckError(error instanceof Error ? error.message : "Health check failed.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="page">
      <header>
        <h1>Bot runtime</h1>
        <p>The first-party meeting bot runtime joins Teams meetings, records audio, and uploads recordings to R2.</p>
      </header>
      {statusError && <p className="errorText">{statusError}</p>}
      <section>
        <h2>Worker status</h2>
        <div className="metricGrid">
          <Metric label="Environment" value={status?.environment ?? "..."} />
          <Metric label="API base URL" value={status?.apiBaseUrl ?? "..."} />
          <Metric label="App base URL" value={status?.appBaseUrl ?? "..."} />
          <Metric label="Bot runtime URL" value={status?.botRuntime?.baseUrl ?? "..."} />
          <Metric label="Connection" value={status?.botRuntime?.viaServiceBinding ? "Service binding" : "HTTP"} />
        </div>
      </section>
      <section>
        <h2>Health check</h2>
        <div className="detailActions">
          <button type="button" className="secondaryButton" disabled={checking} onClick={runHealthCheck}>
            {checking ? "Running health check..." : "Run health check"}
          </button>
          {check && <StatusBadge value={check.ok ? "ok" : "failed"} />}
        </div>
        {checkError && <p className="errorText">{checkError}</p>}
        {check && (
          <>
            <div className="chipRow">
              {flattenChecks(check.health, "health").map((entry) => (
                <span key={entry.label} className={`badge ${entry.ok === null ? "neutral" : entry.ok ? "good" : "bad"}`}>
                  {entry.label}: {entry.value}
                </span>
              ))}
              {flattenChecks(check.ready, "ready").map((entry) => (
                <span key={entry.label} className={`badge ${entry.ok === null ? "neutral" : entry.ok ? "good" : "bad"}`}>
                  {entry.label}: {entry.value}
                </span>
              ))}
            </div>
            <pre>{JSON.stringify(check, null, 2)}</pre>
          </>
        )}
      </section>
      <section>
        <h2>Recent bot failures</h2>
        {failuresError && <p className="errorText">{failuresError}</p>}
        <AuditLogTable logs={failures} timeZone="UTC" />
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}
