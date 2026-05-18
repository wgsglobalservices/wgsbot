import { cleanupOldArtifacts, handleQueueBatch } from "./queueConsumers";
import { queueDueBotCreations } from "./botCreation";
import type { WorkflowEnv } from "./env";

const BOT_SCHEDULER_CRON = "* * * * *";
const CLEANUP_CRON = "17 3 * * *";

export { CleanupWorkflow } from "./cleanupWorkflow";
export { MeetingWorkflow } from "./meetingWorkflow";
export { SummaryWorkflow } from "./summaryWorkflow";
export { TranscriptWorkflow } from "./transcriptWorkflow";

export default {
  async queue(batch: MessageBatch<unknown>, env: WorkflowEnv): Promise<void> {
    await handleQueueBatch(batch, env);
  },
  async scheduled(event: ScheduledEvent, env: WorkflowEnv, ctx: ExecutionContext): Promise<void> {
    if (event.cron === BOT_SCHEDULER_CRON) ctx.waitUntil(queueDueBotCreations(env));
    if (event.cron === CLEANUP_CRON) ctx.waitUntil(cleanupOldArtifacts(env));
  }
};
