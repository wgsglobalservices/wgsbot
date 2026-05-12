import { AppError } from "@minutesbot/shared";
import type { Context, Next } from "hono";
import type { Env } from "../env";

export function createAuthMiddleware() {
  return async function authMiddleware(c: Pick<Context<{ Bindings: Env }>, "env" | "req">, next: Next): Promise<void> {
    const env = (c.env ?? {}) as Env;
    if (isPublicApiPath(c.req.path)) {
      await next();
      return;
    }

    if (!env.SESSION_SECRET) {
      throw new AppError("AUTH_NOT_CONFIGURED", "Configure SESSION_SECRET before exposing admin routes.", 503);
    }

    if (!(await constantTimeEqual(readBearerToken(c.req.raw), env.SESSION_SECRET))) {
      throw new AppError("UNAUTHORIZED", "Enter the admin token to access minutesbot.", 401);
    }

    await next();
  };
}

export function isPublicApiPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/health/" ||
    path === "/api/webhooks/attendee" ||
    path === "/api/webhooks/attendee/" ||
    /^\/api\/artifacts\/[^/]+\/transcript\.txt\/?$/.test(path)
  );
}

export const adminTokenAuthMiddleware = createAuthMiddleware();

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

async function constantTimeEqual(left: string | null, right: string): Promise<boolean> {
  if (!left) return false;
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) diff |= leftBytes[index] ^ rightBytes[index];
  await crypto.subtle.digest("SHA-256", leftBytes);
  return diff === 0;
}
