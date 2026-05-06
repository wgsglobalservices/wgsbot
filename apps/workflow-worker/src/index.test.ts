import { describe, expect, it, vi } from "vitest";

const queueConsumers = vi.hoisted(() => ({
  cleanupOldArtifacts: vi.fn(),
  handleQueueBatch: vi.fn()
}));

vi.mock("./queueConsumers", () => queueConsumers);

describe("workflow worker queue entrypoint", () => {
  it("awaits queue processing before returning", async () => {
    const worker = (await import("./index")).default;
    let completed = false;

    queueConsumers.handleQueueBatch.mockImplementationOnce(async () => {
      await Promise.resolve();
      completed = true;
    });

    await worker.queue({ messages: [] } as unknown as MessageBatch<unknown>, {} as never);

    expect(completed).toBe(true);
  });
});
