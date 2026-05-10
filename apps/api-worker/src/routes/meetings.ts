import { Hono } from "hono";
import { getLatestSummary, getMeeting, listArtifacts, listEmailDeliveries, listMeetingAttendees, listMeetings, listTranscriptSegments, listWebhookEvents, updateMeetingStatus } from "@minutesbot/db";
import { AppError } from "@minutesbot/shared";
import type { Env } from "../env";
import { deleteMeetingArtifacts } from "../services/artifactService";
import { eligibleRecipientCount } from "../services/meetingService";

export const meetingsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const meetings = await listMeetings(c.env.DB);
    const enriched = [];
    for (const meeting of meetings) enriched.push({ ...meeting, eligible_recipient_count: await eligibleRecipientCount(c.env, meeting.id) });
    return c.json({ meetings: enriched });
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
  .post("/:id/delete-bot-data", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "delete_attendee_data", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .post("/:id/delete-attendee-data", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "delete_attendee_data", meetingId: c.req.param("id") });
    return c.json({ ok: true });
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

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
