import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { StatusBadge } from "../components/StatusBadge";
import { TestActionButton } from "../components/TestActionButton";

export function BotStatus() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    apiGet<Record<string, unknown>>("/api/admin/status").then(setStatus).catch((error) => setStatus({ ok: false, error: error.message }));
  }, []);
  const botRuntime = (status?.botRuntime ?? {}) as Record<string, unknown>;
  return (
    <div className="page">
      <header><h1>Meeting bot status</h1><p>The first-party meeting bot runtime joins Teams meetings, records audio, and uploads recordings to R2.</p></header>
      {typeof status?.error === "string" && status.error && <p className="errorText">{status.error}</p>}
      <div className="metricGrid">
        <div className="metric"><span>Connection</span><strong><StatusBadge value={status?.ok ? "ready" : "not_tested"} /></strong></div>
        <div className="metric"><span>Base URL</span><strong>{String(botRuntime.baseUrl ?? "")}</strong></div>
        <div className="metric"><span>Runtime</span><strong>{botRuntime.managed ? "Built in" : "Not tested"}</strong></div>
      </div>
      <section>
        <h2>Webhook URL</h2>
        <pre>{String(status?.webhookUrl ?? "")}</pre>
      </section>
      <TestActionButton path="/api/admin/test-bot" label="Test meeting bot" />
    </div>
  );
}
