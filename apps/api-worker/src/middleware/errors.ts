import { toErrorResponse } from "@minutesbot/shared";
import type { Context, Next } from "hono";

export async function errorMiddleware(c: Context, next: Next): Promise<Response | void> {
  try {
    await next();
  } catch (error) {
    const response = toErrorResponse(error);
    if (response.status >= 500) console.error("api-worker request failed", error);
    return c.json(response.body, response.status as 400);
  }
}
