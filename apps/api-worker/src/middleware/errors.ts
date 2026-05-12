import { toErrorResponse } from "@minutesbot/shared";
import type { Context, Next } from "hono";
import { applySecurityHeaders } from "./securityHeaders";

export async function errorMiddleware(c: Context, next: Next): Promise<Response | void> {
  try {
    await next();
  } catch (error) {
    const response = toErrorResponse(error, c.env?.ENVIRONMENT);
    applySecurityHeaders(c);
    return c.json(response.body, response.status as 400);
  }
}
