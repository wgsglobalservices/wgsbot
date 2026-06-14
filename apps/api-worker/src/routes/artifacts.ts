import { Hono } from "hono";
import { getArtifact, listArtifactsForOwner } from "@minutesbot/db";
import { AppError, type ArtifactOwnerType } from "@minutesbot/shared";
import type { Env } from "../env";

const ownerTypes = new Set<ArtifactOwnerType>(["inbound_message", "calendar_event", "occurrence", "bot_session", "settings"]);

/** Admin-authenticated artifact metadata + content access. Raw artifacts are
 * never exposed without auth; recap emails link to the admin UI instead. */
export const artifactsRoute = new Hono<{ Bindings: Env }>()
  .get("/:id/content", async (c) => {
    const artifact = await getArtifact(c.env.DB, c.req.param("id"));
    if (!artifact || artifact.deleted_at) throw new AppError("NOT_FOUND", "Artifact not found.", 404);
    const object = await c.env.ARTIFACTS.get(artifact.r2_key);
    if (!object) throw new AppError("NOT_FOUND", "Artifact object missing from storage.", 404);
    const filename = artifact.r2_key.split("/").pop() ?? "artifact";
    return new Response(object.body, {
      headers: {
        "content-type": artifact.content_type ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]+/g, "-")}"`,
        "cache-control": "no-store"
      }
    });
  })
  .get("/:ownerType/:ownerId", async (c) => {
    const ownerType = c.req.param("ownerType") as ArtifactOwnerType;
    if (!ownerTypes.has(ownerType)) throw new AppError("INVALID_OWNER", "Unknown artifact owner type.", 400);
    return c.json({ artifacts: await listArtifactsForOwner(c.env.DB, ownerType, c.req.param("ownerId")) });
  });
