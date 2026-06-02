import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiGetBlob, apiGetText, setApiAuthTokenProvider } from "./api";

describe("web api client auth", () => {
  afterEach(() => {
    setApiAuthTokenProvider(null);
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

  it("fetches text artifacts with the admin bearer token", async () => {
    const fetchMock = vi.fn(async () => new Response("Alex: transcript ready", { status: 200, headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    setApiAuthTokenProvider(async () => "session-token");

    await expect(apiGetText("/api/meetings/mtg_1/transcript.txt")).resolves.toBe("Alex: transcript ready");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/meetings/mtg_1/transcript.txt",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer session-token"
        })
      })
    );
  });

  it("fetches recording artifacts as blobs and preserves API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Recording not found." } }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    setApiAuthTokenProvider(async () => "session-token");

    const blob = await apiGetBlob("/api/meetings/mtg_1/recording");

    expect(blob.type).toBe("audio/mpeg");
    await expect(blob.arrayBuffer()).resolves.toHaveProperty("byteLength", 3);
    await expect(apiGetBlob("/api/meetings/mtg_missing/recording")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "NOT_FOUND",
      message: "Recording not found."
    });
  });
});
