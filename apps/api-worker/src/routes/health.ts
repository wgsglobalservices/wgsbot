import { Hono } from "hono";
import type { Env } from "../env";

export const healthRoute = new Hono<{ Bindings: Env }>().get("/", (c) => c.json({ ok: true }));

/** Readiness: verifies the worker can actually reach its bindings. */
export const readyRoute = new Hono<{ Bindings: Env }>().get("/", async (c) => {
  const checks: Record<string, boolean> = {};
  try {
    await c.env.DB.prepare("SELECT 1").first();
    checks.d1 = true;
  } catch {
    checks.d1 = false;
  }
  checks.r2 = typeof c.env.ARTIFACTS?.get === "function";
  checks.queue = typeof c.env.JOBS_QUEUE?.send === "function";
  const ready = Object.values(checks).every(Boolean);
  return c.json({ ready, checks }, ready ? 200 : 503);
});
