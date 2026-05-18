import { createArtifact, deleteMeetingRecord, listArtifacts, markArtifactDeleted } from "@minutesbot/db";
import { createAuditLog } from "./auditService";
import type { Env } from "../env";

export async function putArtifact(env: Env, input: { meetingId: string; key: string; type: string; body: string; contentType: string }): Promise<void> {
  await env.ARTIFACTS.put(input.key, input.body, { httpMetadata: { contentType: input.contentType } });
  await createArtifact(env.DB, {
    meeting_id: input.meetingId,
    type: input.type,
    r2_key: input.key,
    content_type: input.contentType,
    size_bytes: new TextEncoder().encode(input.body).byteLength,
    deleted_at: null
  });
}

export async function deleteMeetingArtifacts(env: Env, meetingId: string): Promise<number> {
  const artifacts = await listArtifacts(env.DB, meetingId);
  let deleted = 0;
  for (const artifact of artifacts.filter((item) => !item.deleted_at)) {
    await env.ARTIFACTS.delete(artifact.r2_key);
    await markArtifactDeleted(env.DB, artifact.id);
    await createAuditLog(env.DB, { eventType: "artifact.deleted", resourceType: "meeting", resourceId: meetingId, metadata: { r2Key: artifact.r2_key } });
    deleted += 1;
  }
  return deleted;
}

export async function deleteMeetingHistory(env: Env, meetingId: string): Promise<{ artifactsDeleted: number }> {
  const artifacts = await listArtifacts(env.DB, meetingId);
  let artifactsDeleted = 0;
  for (const artifact of artifacts.filter((item) => !item.deleted_at)) {
    await env.ARTIFACTS.delete(artifact.r2_key);
    artifactsDeleted += 1;
  }
  await deleteMeetingRecord(env.DB, meetingId);
  await createAuditLog(env.DB, {
    eventType: "meeting.deleted",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { artifactsDeleted }
  });
  return { artifactsDeleted };
}
