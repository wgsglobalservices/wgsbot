import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  container: {
    startAndWaitForPorts: vi.fn(),
    containerFetch: vi.fn(),
    fetch: vi.fn()
  },
  getContainer: vi.fn()
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: mocks.getContainer
}));

vi.mock("cloudflare:workers", () => ({
  env: {}
}));

const { default: botContainerWorker } = await import("./index");

describe("bot container worker", () => {
  beforeEach(() => {
    mocks.container.startAndWaitForPorts.mockReset().mockResolvedValue(undefined);
    mocks.container.containerFetch.mockReset().mockResolvedValue(Response.json({ ok: true }));
    mocks.container.fetch.mockReset().mockResolvedValue(Response.json({ ok: true }));
    mocks.getContainer.mockReset().mockReturnValue(mocks.container);
  });

  it("uses the container RPC fetch path for runtime API requests", async () => {
    const env = {
      MEETING_BOT: {},
      BOT_CONTAINER_INSTANCE_ID: "runtime-1",
      BOT_INTERNAL_TOKEN: "runtime-secret",
      BOT_API_BASE_URL: "https://minutesbot-meeting-api.wgsglobal.app",
      BOT_RECORDING_BUCKET_NAME: "minutesbot-artifacts",
      BOT_RUNTIME_VERSION: "test-version",
      BOT_WEBHOOK_BASE_URL: "https://minutesbot-webhook.wgsglobal.app/hooks"
    };
    const request = new Request("https://minutesbot-meeting-api.wgsglobal.app/_ops/health");

    const response = await botContainerWorker.fetch(request, env as never);

    expect(response.status).toBe(200);
    expect(mocks.getContainer).toHaveBeenCalledWith(env.MEETING_BOT, "runtime-1");
    expect(mocks.container.startAndWaitForPorts).toHaveBeenCalledWith({
      ports: 8787,
      cancellationOptions: expect.objectContaining({ portReadyTimeoutMS: 60_000 }),
      startOptions: {
        entrypoint: ["node", "--import", "tsx", "src/server.ts"],
        envVars: expect.objectContaining({
          BOT_INTERNAL_TOKEN: "runtime-secret",
          BOT_API_BASE_URL: "https://minutesbot-meeting-api.wgsglobal.app",
          BOT_STORAGE_UPLOAD_URL: "https://minutesbot-meeting-api.wgsglobal.app/internal/recordings",
          BOT_WEBHOOK_ALLOWED_ORIGINS: "https://minutesbot-webhook.wgsglobal.app"
        })
      }
    });
    expect(mocks.container.containerFetch).toHaveBeenCalledWith(request, 8787);
    expect(mocks.container.fetch).not.toHaveBeenCalled();
  });
});
