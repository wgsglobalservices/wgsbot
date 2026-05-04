import { cleanupOldArtifacts } from "./queueConsumers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEnv } from "./env";

export class CleanupWorkflow extends WorkflowEntrypoint<WorkflowEnv, Record<string, never>> {
  async run(): Promise<void> {
    await cleanupOldArtifacts(this.env);
  }
}
