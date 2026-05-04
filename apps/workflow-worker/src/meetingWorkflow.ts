/// <reference path="./workflows.d.ts" />

import { AttendeeClient } from "@minutesbot/attendee-client";
import { createAuditLog, getMeeting, getSettings, updateMeetingBotState, updateMeetingStatus } from "@minutesbot/db";
import { AppError, minutesBefore } from "@minutesbot/shared";
import type { WorkflowEnv } from "./env";

type Params = { meetingId: string };

const WorkflowBase: typeof WorkflowEntrypoint =
  (globalThis as unknown as { WorkflowEntrypoint?: typeof WorkflowEntrypoint }).WorkflowEntrypoint ??
  (class {
    env: WorkflowEnv;
    constructor(_state: unknown, env: WorkflowEnv) {
      this.env = env;
    }
  } as unknown as typeof WorkflowEntrypoint);

export class MeetingWorkflow extends WorkflowBase<WorkflowEnv, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<void> {
    const meetingId = event.payload.meetingId;
    const meeting = await step.do("load meeting", () => getMeeting(this.env.DB, meetingId));
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    if (meeting.status === "CANCELLED") return;

    const settings = await step.do("load settings", () => getSettings(this.env.DB));
    const wakeAt = minutesBefore(meeting.start_time ?? new Date().toISOString(), settings.attendee.createBotMinutesBeforeStart);
    await step.sleep("wait until bot create buffer", wakeAt);
    await step.do("mark waiting", () => updateMeetingStatus(this.env.DB, meetingId, "WAITING_TO_CREATE_BOT"));
    await step.do("mark queued", async () => {
      await updateMeetingStatus(this.env.DB, meetingId, "BOT_CREATE_QUEUED");
      await createAuditLog(this.env.DB, { eventType: "bot.create_queued", resourceType: "meeting", resourceId: meetingId });
    });

    const bot = await step.do("create Attendee bot", async () => {
      if (!this.env.ATTENDEE_API_KEY) throw new AppError("ATTENDEE_API_KEY_MISSING", "ATTENDEE_API_KEY secret is not configured", 500);
      const client = new AttendeeClient({ baseUrl: settings.attendee.baseUrl || this.env.ATTENDEE_API_BASE_URL, apiKey: this.env.ATTENDEE_API_KEY });
      return client.createBot({
        meetingUrl: meeting.teams_join_url ?? "",
        botName: settings.attendee.botName,
        webhooks: [
          {
            url: `${this.env.API_BASE_URL}/api/webhooks/attendee`,
            triggers: ["bot.state_change", "transcript.update", "bot_logs.update", "participant_events.join_leave"]
          }
        ],
        metadata: { minutesbot_meeting_id: meeting.id, calendar_uid: meeting.calendar_uid }
      });
    });

    await step.do("store bot id", async () => {
      await updateMeetingBotState(this.env.DB, meetingId, { botId: bot.id, state: bot.state, transcriptionState: bot.transcription_state, recordingState: bot.recording_state, status: "BOT_CREATED" });
      await createAuditLog(this.env.DB, { eventType: "bot.created", resourceType: "meeting", resourceId: meetingId, metadata: { botId: bot.id, state: bot.state } });
    });
  }
}
