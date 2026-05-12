import type { Context, Next } from "hono";

export async function corsMiddleware(c: Context, next: Next): Promise<Response | void> {
  await next();
  const origin = c.req.header("origin");
  if (origin && allowedOrigins(c.env as Record<string, string | undefined>).has(origin)) {
    c.header("access-control-allow-origin", origin);
    c.header("vary", appendVary(c.res.headers.get("vary"), "Origin"));
  }
  c.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  c.header("access-control-allow-headers", "authorization,content-type,x-webhook-signature");
}

function allowedOrigins(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    [env.APP_BASE_URL, env.API_BASE_URL, ...(env.ADMIN_ALLOWED_ORIGINS ?? "").split(",")]
      .map((value) => normalizeOrigin(value))
      .filter((value): value is string => Boolean(value))
  );
}

function normalizeOrigin(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    return url.origin;
  } catch {
    return null;
  }
}

function appendVary(current: string | null, value: string): string {
  if (!current) return value;
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}
