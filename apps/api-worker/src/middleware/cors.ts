import type { Context, Next } from "hono";

export async function corsMiddleware(c: Context, next: Next): Promise<Response | void> {
  await next();
  c.header("access-control-allow-origin", c.req.header("origin") ?? "*");
  c.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
  c.header("access-control-allow-headers", "authorization,content-type");
}
