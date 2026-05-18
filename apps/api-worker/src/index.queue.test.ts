import { describe, expect, it, vi } from "vitest";

const queueConsumers = vi.hoisted(() => ({
  cleanupOldArtifacts: vi.fn(),
  handleQueueBatch: vi.fn()
}));
const botCreation = vi.hoisted(() => ({
  queueDueBotCreations: vi.fn()
}));

vi.mock("../../workflow-worker/src/queueConsumers", () => queueConsumers);
vi.mock("../../workflow-worker/src/botCreation", () => botCreation);

describe("api worker queue entrypoint", () => {
  it("awaits queue processing before returning", async () => {
    const worker = (await import("./index")).default;
    let completed = false;

    queueConsumers.handleQueueBatch.mockImplementationOnce(async () => {
      await Promise.resolve();
      completed = true;
    });

    await worker.queue?.({ messages: [] } as unknown as MessageBatch<unknown>, {} as never);

    expect(completed).toBe(true);
  });

  it("runs bot scheduling on the every-minute cron", async () => {
    const worker = (await import("./index")).default;
    const waitUntil = vi.fn((promise: Promise<unknown>) => promise);
    botCreation.queueDueBotCreations.mockResolvedValueOnce(1);

    await worker.scheduled?.({ cron: "* * * * *" } as ScheduledEvent, {} as never, { waitUntil } as unknown as ExecutionContext);
    await waitUntil.mock.calls[0][0];

    expect(botCreation.queueDueBotCreations).toHaveBeenCalledOnce();
    expect(queueConsumers.cleanupOldArtifacts).not.toHaveBeenCalled();
  });
});
