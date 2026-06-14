import { Hono } from "hono";
import {
  createAuditLog,
  deleteCalendarEventCascade,
  getCalendarEvent,
  listArtifactsForOwner,
  listCalendarEvents,
  listEventAttendees,
  listInboundMessagesForEvent,
  listOccurrencesForEvent,
  cancelJobsForOwner
} from "@minutesbot/db";
import { AppError } from "@minutesbot/shared";
import type { Env } from "../env";

export const eventsRoute = new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    const events = await listCalendarEvents(c.env.DB, {
      status: c.req.query("status") as "active" | "canceled" | undefined,
      limit: Number(c.req.query("limit") ?? 200)
    });
    return c.json({ events });
  })
  .get("/:id", async (c) => {
    const event = await getCalendarEvent(c.env.DB, c.req.param("id"));
    if (!event) throw new AppError("NOT_FOUND", "Calendar event not found.", 404);
    const [occurrences, attendees, inboundMessages] = await Promise.all([
      listOccurrencesForEvent(c.env.DB, event.id),
      listEventAttendees(c.env.DB, event.id),
      listInboundMessagesForEvent(c.env.DB, event.id)
    ]);
    return c.json({ event, occurrences, attendees, inboundMessages });
  })
  .delete("/:id", async (c) => {
    const event = await getCalendarEvent(c.env.DB, c.req.param("id"));
    if (!event) throw new AppError("NOT_FOUND", "Calendar event not found.", 404);
    const occurrences = await listOccurrencesForEvent(c.env.DB, event.id);
    // Purge R2 objects referenced by the event tree before dropping rows.
    const ownerIds = [event.id, ...occurrences.map((row) => row.id)];
    for (const ownerType of ["calendar_event", "occurrence"] as const) {
      for (const ownerId of ownerIds) {
        const artifacts = await listArtifactsForOwner(c.env.DB, ownerType, ownerId);
        for (const artifact of artifacts) {
          await c.env.ARTIFACTS.delete(artifact.r2_key);
        }
      }
    }
    for (const occurrence of occurrences) {
      await cancelJobsForOwner(c.env.DB, "occurrence", occurrence.id);
    }
    await deleteCalendarEventCascade(c.env.DB, event.id);
    await createAuditLog(c.env.DB, {
      eventType: "admin.delete",
      resourceType: "calendar_event",
      resourceId: event.id,
      message: `Event ${event.subject ?? event.ics_uid} deleted by admin`
    });
    return c.json({ ok: true });
  });
