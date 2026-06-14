import { createId, nowIso, type AuditEventType, type AuditSeverity } from "@minutesbot/shared";
import type { AuditLogRow } from "./schema";

export async function createAuditLog(
  db: D1Database,
  input: {
    actorEmail?: string;
    eventType: AuditEventType | string;
    severity?: AuditSeverity;
    resourceType?: string;
    resourceId?: string;
    message?: string;
    metadata?: unknown;
  }
): Promise<AuditLogRow> {
  const row: AuditLogRow = {
    id: createId("aud"),
    actor_email: input.actorEmail ?? null,
    event_type: input.eventType,
    severity: input.severity ?? "info",
    resource_type: input.resourceType ?? null,
    resource_id: input.resourceId ?? null,
    message: input.message ?? null,
    metadata: input.metadata === undefined ? null : JSON.stringify(input.metadata),
    created_at: nowIso()
  };
  await db
    .prepare(
      "INSERT INTO audit_logs (id, actor_email, event_type, severity, resource_type, resource_id, message, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(row.id, row.actor_email, row.event_type, row.severity, row.resource_type, row.resource_id, row.message, row.metadata, row.created_at)
    .run();
  return row;
}

export async function listAuditLogs(
  db: D1Database,
  filters: { eventType?: string; resourceId?: string; severity?: AuditSeverity; limit?: number } = {}
): Promise<AuditLogRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (filters.eventType) {
    clauses.push("event_type = ?");
    binds.push(filters.eventType);
  }
  if (filters.resourceId) {
    clauses.push("resource_id = ?");
    binds.push(filters.resourceId);
  }
  if (filters.severity) {
    clauses.push("severity = ?");
    binds.push(filters.severity);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(filters.limit ?? 200, 500);
  const result = await db
    .prepare(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<AuditLogRow>();
  return result.results ?? [];
}

export async function deleteAuditLogsBefore(db: D1Database, cutoffIso: string): Promise<number> {
  const result = await db.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(cutoffIso).run();
  return (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
}
