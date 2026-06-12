import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { createMeetingBot } from "./botCreation";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string };

export class MeetingWorkflow extends WorkflowEntrypoint<WorkflowEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    await step.do("create meeting bot", () => createMeetingBot(this.env, event.payload.meetingId));
  }
}
