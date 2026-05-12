import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, setApiAuthTokenProvider } from "./lib/api";
import { getStoredAdminToken, setStoredAdminTokenProvider } from "./AuthGate";

describe("AuthGate API token storage", () => {
  afterEach(() => {
    setApiAuthTokenProvider(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes the stored admin token available before route effects run", async () => {
    const storage = new Map([["minutesbot.adminToken", "stored-token"]]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null
      }
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    setStoredAdminTokenProvider();

    await expect(apiGet<{ ok: boolean }>("/api/settings")).resolves.toEqual({ ok: true });

    expect(getStoredAdminToken()).toBe("stored-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer stored-token"
        })
      })
    );
  });
});
