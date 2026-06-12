import { Hono } from "hono";
import { BotClient } from "@minutesbot/bot-client";
import { countEligibleRecipientsByMeeting, createAuditLog, getLatestSummary, getMeeting, listArtifacts, listEmailDeliveries, listMeetingAttendees, listMeetings, listTranscriptSegments, listWebhookEvents, updateMeetingBotState, updateMeetingStatus } from "@minutesbot/db";
import { AppError, isTerminalBotState, mapBotStateToMeetingStatus } from "@minutesbot/shared";
import type { Env } from "../env";
import { deleteMeetingArtifacts, deleteMeetingHistory } from "../services/artifactService";
import { readSettings } from "../services/settingsService";

export const meetingsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const [meetings, eligibleCounts] = await Promise.all([listMeetings(c.env.DB), countEligibleRecipientsByMeeting(c.env.DB)]);
    return c.json({ meetings: meetings.map((meeting) => ({ ...meeting, eligible_recipient_count: eligibleCounts.get(meeting.id) ?? 0 })) });
  })
  .get("/:id", async (c) => {
    const id = c.req.param("id");
    const meeting = await getMeeting(c.env.DB, id);
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    const webhookEvents = await listWebhookEvents(c.env.DB, id);
    return c.json({
      meeting: {
        ...meeting,
        latest_error: meeting.latest_error ?? (meeting.status === "BOT_FATAL_ERROR" ? latestWebhookError(webhookEvents, meeting.attendee_bot_id ?? null) : null)
      },
      attendees: await listMeetingAttendees(c.env.DB, id),
      transcriptSegments: await listTranscriptSegments(c.env.DB, id),
      artifacts: await listArtifacts(c.env.DB, id),
      webhookEvents,
      emailDeliveries: await listEmailDeliveries(c.env.DB, id),
      summary: await getLatestSummary(c.env.DB, id)
    });
  })
  .post("/:id/retry-bot", async (c) => {
    const id = c.req.param("id");
    await updateMeetingStatus(c.env.DB, id, "BOT_CREATE_QUEUED");
    await c.env.INVITE_QUEUE.send({ type: "create_bot", meetingId: id });
    return c.json({ ok: true });
  })
  .post("/:id/retry-summary", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "summarize", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/fetch-transcript", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "fetch_transcript", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/force-end-recording", async (c) => {
    const id = c.req.param("id");
    const meeting = await getMeeting(c.env.DB, id);
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    const botId = meeting.attendee_bot_id;
    if (!botId) throw new AppError("BOT_NOT_FOUND", "Meeting does not have a bot recording to end.", 409);
    if (isTerminalBotState(meeting.attendee_bot_state, meeting.status)) {
      return c.json({ ok: true, alreadyEnded: true, bot: { id: botId, state: meeting.attendee_bot_state } });
    }

    await createAuditLog(c.env.DB, {
      eventType: "bot.cancel_requested",
      resourceType: "meeting",
      resourceId: id,
      metadata: { botId, reason: "force_end_recording" }
    });
    const settings = await readSettings(c.env);
    const client = new BotClient({
      baseUrl: settings.attendee.baseUrl,
      internalToken: c.env.BOT_INTERNAL_TOKEN,
      fetcher: c.env.BOT_RUNTIME ? (input, init) => c.env.BOT_RUNTIME!.fetch(input, init) : undefined
    });

    try {
      const bot = await client.cancelBot(botId);
      await updateMeetingBotState(c.env.DB, id, {
        botId,
        state: bot.state,
        transcriptionState: bot.transcription_state,
        recordingState: bot.recording_state,
        status: mapForceEndBotStateToMeetingStatus(bot.state),
        latestError: bot.latest_error
      });
      await createAuditLog(c.env.DB, {
        eventType: forceEndAuditEventType(bot.state),
        resourceType: "meeting",
        resourceId: id,
        metadata: { botId, reason: "force_end_recording", state: bot.state }
      });
      return c.json({ ok: true, bot });
    } catch (error) {
      const latestError = error instanceof Error ? error.message : String(error);
      await updateMeetingBotState(c.env.DB, id, { botId, status: "BOT_LEAVING", latestError });
      await createAuditLog(c.env.DB, {
        eventType: "bot.cancel_failed",
        resourceType: "meeting",
        resourceId: id,
        metadata: { botId, reason: "force_end_recording", error: latestError }
      });
      throw error;
    }
  })
  .post("/:id/delete-bot-data", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "delete_attendee_data", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/delete-attendee-data", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "delete_attendee_data", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const meeting = await getMeeting(c.env.DB, id);
    if (!meeting) throw new AppError("NOT_FOUND", "Meeting not found", 404);
    return c.json({ ok: true, ...(await deleteMeetingHistory(c.env, id)) });
  })
  .delete("/:id/artifacts", async (c) => c.json({ ok: true, deleted: await deleteMeetingArtifacts(c.env, c.req.param("id")) }));

function latestWebhookError(events: Array<{ attendee_bot_id?: string | null; payload?: unknown }>, botId: string | null): string | null {
  for (const event of events) {
    if (botId && event.attendee_bot_id && event.attendee_bot_id !== botId) continue;
    const payload = typeof event.payload === "string" ? parseJsonObject(event.payload) : null;
    const data = payload && typeof payload.data === "object" && payload.data ? payload.data as Record<string, unknown> : null;
    if (typeof data?.latest_error === "string" && data.latest_error.trim()) return data.latest_error;
  }
  return null;
}

function mapForceEndBotStateToMeetingStatus(state?: string) {
  if (state === "ended") return "BOT_ENDED";
  if (state === "post_processing") return "BOT_POST_PROCESSING";
  if (state === "failed" || state?.includes("fatal") || state?.includes("error")) return "BOT_FATAL_ERROR";
  return mapBotStateToMeetingStatus(state === "cancelled" ? "cancelling" : state, "cancel_requested") ?? "BOT_LEAVING";
}

function forceEndAuditEventType(state?: string): string {
  if (state === "ended") return "bot.ended";
  if (state === "post_processing") return "bot.post_processing";
  if (state === "failed" || state?.includes("fatal") || state?.includes("error")) return "bot.fatal_error";
  return "bot.cancel_requested";
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
