import { createArtifact, deleteMeetingHistory as deleteMeetingHistoryRows, listArtifacts, listSummaryR2Keys, markArtifactDeleted } from "@minutesbot/db";
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

export async function deleteMeetingHistory(env: Env, meetingId: string): Promise<{ objectsDeleted: number }> {
  const artifacts = await listArtifacts(env.DB, meetingId);
  const summaryKeys = await listSummaryR2Keys(env.DB, meetingId);
  const keys = new Set([
    ...artifacts.filter((artifact) => !artifact.deleted_at).map((artifact) => artifact.r2_key),
    ...summaryKeys
  ]);
  for (const key of keys) {
    await env.ARTIFACTS.delete(key);
  }
  await deleteMeetingHistoryRows(env.DB, meetingId);
  await createAuditLog(env.DB, {
    eventType: "meeting.deleted",
    resourceType: "meeting",
    resourceId: meetingId,
    metadata: { objectsDeleted: keys.size }
  });
  return { objectsDeleted: keys.size };
}
