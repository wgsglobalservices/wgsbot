import type { Context, Next } from "hono";

export function applySecurityHeaders(c: Context): void {
  c.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

export async function securityHeadersMiddleware(c: Context, next: Next): Promise<Response | void> {
  await next();
  applySecurityHeaders(c);
}
