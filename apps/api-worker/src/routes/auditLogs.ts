import { Hono } from "hono";
import { listAuditLogs } from "@minutesbot/db";
import type { AuditSeverity } from "@minutesbot/shared";
import type { Env } from "../env";

export const auditLogsRoute = new Hono<{ Bindings: Env }>().get("/", async (c) =>
  c.json({
    auditLogs: await listAuditLogs(c.env.DB, {
      eventType: c.req.query("eventType"),
      resourceId: c.req.query("resourceId"),
      severity: c.req.query("severity") as AuditSeverity | undefined,
      limit: Number(c.req.query("limit") ?? 200)
    })
  })
);
