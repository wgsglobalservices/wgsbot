import { AppError, timingSafeEqualString } from "@minutesbot/shared";
import type { Context, Next } from "hono";
import type { Env } from "../env";
import { isCloudflareAccessConfigured, requireCloudflareAccess } from "./cloudflareAccess";

type AuthMiddlewareOptions = {
  fetchAccessJwks?: typeof fetch;
  now?: () => number;
};

export function createAuthMiddleware(options: AuthMiddlewareOptions = {}) {
  return async function authMiddleware(c: Pick<Context<{ Bindings: Env }>, "env" | "req">, next: Next): Promise<void> {
    const env = (c.env ?? {}) as Env;
    if (isPublicApiPath(c.req.path)) {
      await next();
      return;
    }

    if (isCloudflareAccessConfigured(env)) {
      await requireCloudflareAccess(c.req.raw, env, { fetcher: options.fetchAccessJwks, now: options.now });
      await next();
      return;
    }

    if (requiresCloudflareAccess(env)) {
      throw new AppError(
        "CLOUDFLARE_ACCESS_REQUIRED",
        "Configure Cloudflare Access before exposing production admin routes.",
        503
      );
    }

    if (!env.SESSION_SECRET) {
      throw new AppError("AUTH_NOT_CONFIGURED", "Configure SESSION_SECRET before exposing admin routes.", 503);
    }

    const token = readBearerToken(c.req.raw);
    if (!token || !timingSafeEqualString(token, env.SESSION_SECRET)) {
      throw new AppError("UNAUTHORIZED", "Enter the admin token to access minutesbot.", 401);
    }

    await next();
  };
}

export function isPublicApiPath(path: string): boolean {
  return (
    path === "/api/health" ||
    path === "/api/health/" ||
    path === "/api/ready" ||
    path === "/api/ready/" ||
    path === "/api/webhooks/bot" ||
    path === "/api/webhooks/bot/"
  );
}

export const adminTokenAuthMiddleware = createAuthMiddleware();

// Fail closed: any named deployed environment ("production", "staging", a
// typo like "prod") requires Cloudflare Access unless token auth is
// explicitly allowed. Only unset/development/test environments may fall back
// to the static admin token implicitly.
function requiresCloudflareAccess(env: Pick<Env, "ENVIRONMENT" | "ALLOW_ADMIN_TOKEN_AUTH">): boolean {
  if (env.ALLOW_ADMIN_TOKEN_AUTH === "true") return false;
  const environment = (env.ENVIRONMENT ?? "").trim().toLowerCase();
  return environment !== "" && environment !== "development" && environment !== "test" && environment !== "local";
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || !token) return null;
  return token;
}
