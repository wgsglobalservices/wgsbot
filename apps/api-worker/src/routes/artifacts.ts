import { Hono } from "hono";
import { listArtifacts } from "@minutesbot/db";
import { AppError, verifyTranscriptDownloadToken } from "@minutesbot/shared";
import type { Env } from "../env";

export const artifactsRoute = new Hono<{ Bindings: Env }>()
  .get("/:meetingId", async (c) => c.json({ artifacts: await listArtifacts(c.env.DB, c.req.param("meetingId")) }))
  .get("/:meetingId/transcript.txt", async (c) => {
    const token = c.req.query("token");
    if (!c.env.TRANSCRIPT_LINK_SECRET) throw new AppError("TRANSCRIPT_LINKS_NOT_CONFIGURED", "Transcript download links are not configured.", 503);
    if (!token) throw new AppError("UNAUTHORIZED", "Transcript download link is invalid or expired.", 401);
    const payload = await verifyTranscriptDownloadToken(token, c.env.TRANSCRIPT_LINK_SECRET);
    const meetingId = c.req.param("meetingId");
    if (!payload || payload.meetingId !== meetingId) throw new AppError("UNAUTHORIZED", "Transcript download link is invalid or expired.", 401);

    const artifacts = await listArtifacts(c.env.DB, meetingId);
    const transcriptArtifact = artifacts.find((artifact) => artifact.type === "transcript_text" && !artifact.deleted_at);
    if (!transcriptArtifact) throw new AppError("NOT_FOUND", "Transcript not found.", 404);
    const object = await c.env.ARTIFACTS.get(transcriptArtifact.r2_key);
    const transcript = await object?.text();
    if (!transcript) throw new AppError("NOT_FOUND", "Transcript not found.", 404);
    return new Response(transcript, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-disposition": `attachment; filename="${safeFilename(meetingId)}-transcript.txt"`
      }
    });
  });

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "meeting";
}
