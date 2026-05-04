/// <reference path="./workflows.d.ts" />

import { cleanupOldArtifacts } from "./queueConsumers";
import type { WorkflowEnv } from "./env";

const WorkflowBase: typeof WorkflowEntrypoint =
  (globalThis as unknown as { WorkflowEntrypoint?: typeof WorkflowEntrypoint }).WorkflowEntrypoint ??
  (class {
    env: WorkflowEnv;
    constructor(_state: unknown, env: WorkflowEnv) {
      this.env = env;
    }
  } as unknown as typeof WorkflowEntrypoint);

export class CleanupWorkflow extends WorkflowBase<WorkflowEnv, Record<string, never>> {
  async run(): Promise<void> {
    await cleanupOldArtifacts(this.env);
  }
}
