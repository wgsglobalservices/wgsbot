import { cleanupOldArtifacts, handleQueueBatch } from "./queueConsumers";
import type { WorkflowEnv } from "./env";

export { CleanupWorkflow } from "./cleanupWorkflow";
export { MeetingWorkflow } from "./meetingWorkflow";
export { SummaryWorkflow } from "./summaryWorkflow";
export { TranscriptWorkflow } from "./transcriptWorkflow";

export default {
  async queue(batch: MessageBatch<unknown>, env: WorkflowEnv): Promise<void> {
    await handleQueueBatch(batch, env);
  },
  async scheduled(_event: ScheduledEvent, env: WorkflowEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupOldArtifacts(env));
  }
};
