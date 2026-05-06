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
    return c.json({
      meeting,
      attendees: await listMeetingAttendees(c.env.DB, id),
      transcriptSegments: await listTranscriptSegments(c.env.DB, id),
      artifacts: await listArtifacts(c.env.DB, id),
      webhookEvents: await listWebhookEvents(c.env.DB, id),
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
    await c.env.SUMMARY_QUEUE.send({ type: "fetch_transcript", meetingId: c.req.param("id"), forceAttendeeFetch: true });
    return c.json({ ok: true });
  })
  .post("/:id/delete-attendee-data", async (c) => {
    await c.env.SUMMARY_QUEUE.send({ type: "delete_attendee_data", meetingId: c.req.param("id") });
    return c.json({ ok: true });
  })
  .delete("/:id/artifacts", async (c) => c.json({ ok: true, deleted: await deleteMeetingArtifacts(c.env, c.req.param("id")) }));
