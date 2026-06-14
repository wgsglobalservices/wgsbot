import type { Context, Next } from "hono";
import type { Env } from "../env";

const fallbackAllowedHeaders = "authorization,content-type";

export async function corsMiddleware(c: Context, next: Next): Promise<Response | void> {
  if (c.req.method === "OPTIONS") {
    applyCorsHeaders(c);
    return c.body(null, 204);
  }
  await next();
  applyCorsHeaders(c);
}

function applyCorsHeaders(c: Context<{ Bindings: Env }>): void {
  const origin = c.req.header("origin");
  const allowedOrigin = allowedCorsOrigin(c.env, origin);
  if (allowedOrigin) c.header("access-control-allow-origin", allowedOrigin);
  c.header("vary", "Origin");
  c.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  c.header("access-control-allow-headers", fallbackAllowedHeaders);
}

function allowedCorsOrigin(env: Pick<Env, "APP_BASE_URL"> | undefined, origin: string | undefined): string | null {
  if (!origin) return null;
  if (!env?.APP_BASE_URL) return null;
  try {
    return new URL(origin).origin === new URL(env.APP_BASE_URL).origin ? origin : null;
  } catch {
    return null;
  }
}
