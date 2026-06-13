import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  container: {
    startAndWaitForPorts: vi.fn(),
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
    mocks.container.fetch.mockReset().mockResolvedValue(Response.json({ ok: true }));
    mocks.getContainer.mockReset().mockReturnValue(mocks.container);
  });

  it("starts the container port before proxying runtime requests", async () => {
    const env = {
      MEETING_BOT: {},
      BOT_CONTAINER_INSTANCE_ID: "runtime-1"
    };
    const request = new Request("https://minutesbot-meeting-api.wgsglobal.app/_ops/health");

    const response = await botContainerWorker.fetch(request, env as never);

    expect(response.status).toBe(200);
    expect(mocks.getContainer).toHaveBeenCalledWith(env.MEETING_BOT, "runtime-1");
    expect(mocks.container.startAndWaitForPorts).toHaveBeenCalledWith(8787, expect.objectContaining({ portReadyTimeoutMS: 60_000 }));
    expect(mocks.container.fetch).toHaveBeenCalledWith(request);
  });
});
