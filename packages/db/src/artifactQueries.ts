import { createId, nowIso, type ArtifactKind, type ArtifactOwnerType } from "@minutesbot/shared";
import type { ArtifactRow } from "./schema";

export type CreateArtifactInput = {
  ownerType: ArtifactOwnerType;
  ownerId: string;
  kind: ArtifactKind;
  r2Key: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  expiresAt?: string | null;
};

/**
 * Records an R2 object pointer. Re-uploads to the same key update the
 * existing row in place (the r2_key is globally unique).
 */
export async function upsertArtifact(db: D1Database, input: CreateArtifactInput): Promise<ArtifactRow> {
  const now = nowIso();
  const row: ArtifactRow = {
    id: createId("art"),
    owner_type: input.ownerType,
    owner_id: input.ownerId,
    kind: input.kind,
    r2_key: input.r2Key,
    content_type: input.contentType ?? null,
    size_bytes: input.sizeBytes ?? null,
    sha256: input.sha256 ?? null,
    created_at: now,
    expires_at: input.expiresAt ?? null,
    deleted_at: null
  };
  await db
    .prepare(
      `INSERT INTO artifacts (id, owner_type, owner_id, kind, r2_key, content_type, size_bytes, sha256, created_at, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(r2_key) DO UPDATE SET
         owner_type = excluded.owner_type,
         owner_id = excluded.owner_id,
         kind = excluded.kind,
         content_type = excluded.content_type,
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256,
         expires_at = excluded.expires_at,
         deleted_at = NULL`
    )
    .bind(
      row.id,
      row.owner_type,
      row.owner_id,
      row.kind,
      row.r2_key,
      row.content_type,
      row.size_bytes,
      row.sha256,
      row.created_at,
      row.expires_at,
      row.deleted_at
    )
    .run();
  const saved = await getArtifactByKey(db, input.r2Key);
  return saved ?? row;
}

export async function getArtifact(db: D1Database, id: string): Promise<ArtifactRow | null> {
  return db.prepare("SELECT * FROM artifacts WHERE id = ?").bind(id).first<ArtifactRow>();
}

export async function getArtifactByKey(db: D1Database, r2Key: string): Promise<ArtifactRow | null> {
  return db.prepare("SELECT * FROM artifacts WHERE r2_key = ?").bind(r2Key).first<ArtifactRow>();
}

export async function listArtifactsForOwner(db: D1Database, ownerType: ArtifactOwnerType, ownerId: string): Promise<ArtifactRow[]> {
  const result = await db
    .prepare("SELECT * FROM artifacts WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC")
    .bind(ownerType, ownerId)
    .all<ArtifactRow>();
  return result.results ?? [];
}

export async function listArtifactsForOwners(
  db: D1Database,
  ownerType: ArtifactOwnerType,
  ownerIds: string[]
): Promise<ArtifactRow[]> {
  if (ownerIds.length === 0) return [];
  const placeholders = ownerIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT * FROM artifacts WHERE owner_type = ? AND owner_id IN (${placeholders}) ORDER BY created_at DESC`)
    .bind(ownerType, ...ownerIds)
    .all<ArtifactRow>();
  return result.results ?? [];
}

export async function markArtifactDeleted(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE artifacts SET deleted_at = ? WHERE id = ?").bind(nowIso(), id).run();
}

/** Artifacts whose retention window has lapsed and that still hold an R2 object. */
export async function listExpiredArtifacts(db: D1Database, nowCutoffIso: string, limit = 500): Promise<ArtifactRow[]> {
  const result = await db
    .prepare("SELECT * FROM artifacts WHERE expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL LIMIT ?")
    .bind(nowCutoffIso, Math.min(limit, 1000))
    .all<ArtifactRow>();
  return result.results ?? [];
}

/** Artifacts of a kind created before the cutoff — for kind-based retention. */
export async function listArtifactsByKindBefore(
  db: D1Database,
  kinds: ArtifactKind[],
  cutoffIso: string,
  limit = 500
): Promise<ArtifactRow[]> {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT * FROM artifacts WHERE kind IN (${placeholders}) AND created_at < ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT ?`
    )
    .bind(...kinds, cutoffIso, Math.min(limit, 1000))
    .all<ArtifactRow>();
  return result.results ?? [];
}
