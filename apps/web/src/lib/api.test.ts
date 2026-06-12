import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_TOKEN_STORAGE_KEY, ApiError, apiGet, setApiAuthTokenProvider, verifyAdminToken } from "./api";

describe("web api client auth", () => {
  afterEach(() => {
    setApiAuthTokenProvider(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("adds an admin bearer token when one is available", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setApiAuthTokenProvider(async () => "session-token");

    await expect(apiGet<{ ok: boolean }>("/api/health")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer session-token"
        })
      })
    );
  });

  it("preserves API error status and code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "AUTH_NOT_CONFIGURED",
              message: "Configure SESSION_SECRET before exposing admin routes."
            }
          }),
          { status: 503 }
        )
      )
    );

    await expect(apiGet<{ ok: boolean }>("/api/settings")).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      code: "AUTH_NOT_CONFIGURED",
      message: "Configure SESSION_SECRET before exposing admin routes."
    });
    await expect(apiGet<{ ok: boolean }>("/api/settings")).rejects.toBeInstanceOf(ApiError);
  });

  it("clears the stored admin token on an unauthorized response", async () => {
    const storage = new Map([[ADMIN_TOKEN_STORAGE_KEY, "stale-token"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key)
      }
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid admin token" } }), { status: 401 }))
    );

    await expect(apiGet<{ ok: boolean }>("/api/settings")).rejects.toMatchObject({ status: 401 });
    expect(storage.has(ADMIN_TOKEN_STORAGE_KEY)).toBe(false);
  });

  it("verifies a candidate admin token with a bearer header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyAdminToken("candidate-token")).resolves.toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/status", {
      headers: { authorization: "Bearer candidate-token" }
    });
  });

  it("uses plain admin test action messages on failed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, message: "BOT_UPSTREAM_ERROR: Meeting bot request failed with 502" }), { status: 502 })
      )
    );

    await expect(apiGet<{ ok: boolean }>("/api/admin/status")).rejects.toMatchObject({
      status: 502,
      code: "REQUEST_FAILED",
      message: "BOT_UPSTREAM_ERROR: Meeting bot request failed with 502"
    });
  });
});
