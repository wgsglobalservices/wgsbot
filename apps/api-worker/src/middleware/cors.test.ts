import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "./cors";

describe("cors middleware", () => {
  it("allows only configured application origins", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.get("/api/settings", (c) => c.json({ ok: true }));

    const allowed = await app.request(
      "/api/settings",
      { headers: { origin: "https://minutesbot-admin.wgsglobal.app" } },
      {
        APP_BASE_URL: "https://minutesbot-admin.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app"
      }
    );
    const blocked = await app.request(
      "/api/settings",
      { headers: { origin: "https://evil.example.net" } },
      {
        APP_BASE_URL: "https://minutesbot-admin.wgsglobal.app",
        API_BASE_URL: "https://minutesbot-api.wgsglobal.app"
      }
    );

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://minutesbot-admin.wgsglobal.app");
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("supports explicit comma-separated extra origins", async () => {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.get("/api/settings", (c) => c.json({ ok: true }));

    const response = await app.request(
      "/api/settings",
      { headers: { origin: "https://ops.example.net" } },
      {
        APP_BASE_URL: "https://minutesbot-admin.wgsglobal.app",
        ADMIN_ALLOWED_ORIGINS: "https://ops.example.net, https://backup.example.net"
      }
    );

    expect(response.headers.get("access-control-allow-origin")).toBe("https://ops.example.net");
  });
});
