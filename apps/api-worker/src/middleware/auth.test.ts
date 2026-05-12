import { describe, expect, it, vi } from "vitest";
import { AppError } from "@minutesbot/shared";
import { adminTokenAuthMiddleware, createAuthMiddleware, isPublicApiPath } from "./auth";

describe("auth middleware", () => {
  it("leaves health and attendee webhook routes public", () => {
    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/webhooks/attendee")).toBe(true);
    expect(isPublicApiPath("/api/settings")).toBe(false);
  });

  it("allows requests with the configured admin token", async () => {
    const next = vi.fn();
    const middleware = createAuthMiddleware();

    await middleware(
      ({
        req: {
          path: "/api/settings",
          raw: new Request("https://app.example.com/api/settings", { headers: { authorization: "Bearer secret-token" } })
        },
        env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com" }
      } as any),
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects protected routes when the admin token secret is not configured", async () => {
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings") },
          env: { APP_BASE_URL: "https://app.example.com" }
        } as any),
        vi.fn()
      )
    ).rejects.toMatchObject(new AppError("AUTH_NOT_CONFIGURED", "Configure SESSION_SECRET before exposing admin routes.", 503));
  });

  it("rejects requests without the configured admin token", async () => {
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings") },
          env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com" }
        } as any),
        vi.fn()
      )
    ).rejects.toMatchObject(new AppError("UNAUTHORIZED", "Enter the admin token to access minutesbot.", 401));
  });

  it("compares bearer tokens without relying on direct string equality", async () => {
    const next = vi.fn();
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: {
            path: "/api/settings",
            raw: new Request("https://app.example.com/api/settings", { headers: { authorization: "Bearer secret-token-extra" } })
          },
          env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com" }
        } as any),
        next
      )
    ).rejects.toMatchObject(new AppError("UNAUTHORIZED", "Enter the admin token to access minutesbot.", 401));
    expect(next).not.toHaveBeenCalled();
  });

  it("exports the default admin token middleware", () => {
    expect(adminTokenAuthMiddleware).toBeTypeOf("function");
  });
});
