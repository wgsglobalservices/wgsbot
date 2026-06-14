import { describe, expect, it } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import { createMigratedD1 } from "../../../tests/d1Sqlite";
import { upsertCalendarEvent, cancelCalendarEvent, getCalendarEventByUid, listEventsNeedingExpansion, markEventExpanded } from "./eventQueries";
import {
  cancelOccurrences,
  getOccurrence,
  listOccurrencesForEvent,
  pruneObsoleteOccurrences,
  updateOccurrenceStatus,
  upsertOccurrence
} from "./occurrenceQueries";
import { createBotSession, getActiveBotSession, insertBotEvent, listStaleBotSessions, updateBotSessionState } from "./botSessionQueries";
import { completeJob, computeBackoffIso, cancelJobsForOwner, createJob, failJob, leaseJob, listDueJobs, requeueJob } from "./jobQueries";
import { createInboundMessage, resolveInboundMessage, getInboundMessage } from "./inboundMessageQueries";
import { getSettings, listAllowedDomains, saveSettings } from "./settingsQueries";
import { upsertEmailDelivery, listDeliveriesForRecap } from "./emailQueries";
import { ensureRecap } from "./recapQueries";
import { ensureTranscript, updateTranscript, getTranscriptForOccurrence } from "./transcriptQueries";
import { replaceAttendees, listEffectiveAttendees } from "./attendeeQueries";
import { upsertArtifact, listExpiredArtifacts } from "./artifactQueries";

const pastIso = "2020-01-01T00:00:00.000Z";
const futureIso = "2100-01-01T00:00:00.000Z";

async function makeEvent(db: D1Database, uid = "uid-1", sequence = 0) {
  const { event } = await upsertCalendarEvent(db, {
    icsUid: uid,
    sequence,
    organizerEmail: "organizer@company.com",
    subject: "Weekly sync",
    teamsJoinUrl: "https://teams.microsoft.com/l/meetup-join/abc/0",
    startTime: "2026-07-01T14:00:00.000Z",
    endTime: "2026-07-01T15:00:00.000Z",
    rrule: "FREQ=WEEKLY;BYDAY=WE"
  });
  return event;
}

async function makeOccurrence(db: D1Database, eventId: string, key = "20260701T140000Z") {
  const { occurrence } = await upsertOccurrence(db, {
    eventId,
    occurrenceKey: key,
    startTime: "2026-07-01T14:00:00.000Z",
    endTime: "2026-07-01T15:00:00.000Z"
  });
  return occurrence;
}

describe("calendar event queries", () => {
  it("creates, updates, and guards against stale sequences", async () => {
    const db = createMigratedD1();
    const created = await upsertCalendarEvent(db, { icsUid: "uid-1", sequence: 1, subject: "First" });
    expect(created.created).toBe(true);
    expect(created.event.is_recurring).toBe(0);

    const updated = await upsertCalendarEvent(db, { icsUid: "uid-1", sequence: 2, subject: "Second" });
    expect(updated.created).toBe(false);
    expect(updated.applied).toBe(true);
    expect(updated.event.subject).toBe("Second");
    expect(updated.event.id).toBe(created.event.id);

    const stale = await upsertCalendarEvent(db, { icsUid: "uid-1", sequence: 1, subject: "Replay" });
    expect(stale.applied).toBe(false);
    expect((await getCalendarEventByUid(db, "uid-1"))?.subject).toBe("Second");
  });

  it("tracks recurrence expansion windows", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    expect(event.is_recurring).toBe(1);
    let needing = await listEventsNeedingExpansion(db, "2026-12-01T00:00:00.000Z");
    expect(needing.map((row) => row.id)).toContain(event.id);

    await markEventExpanded(db, event.id, "2027-01-01T00:00:00.000Z");
    needing = await listEventsNeedingExpansion(db, "2026-12-01T00:00:00.000Z");
    expect(needing.map((row) => row.id)).not.toContain(event.id);
  });

  it("cancels with a sequence guard", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db, "uid-c", 5);
    expect(await cancelCalendarEvent(db, event.id, 6)).toBe(true);
    expect((await getCalendarEventByUid(db, "uid-c"))?.status).toBe("canceled");
    expect(await cancelCalendarEvent(db, event.id, 3)).toBe(false);
  });
});

describe("occurrence queries", () => {
  it("creates occurrences idempotently per (event, key)", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const first = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: "20260701T140000Z",
      startTime: "2026-07-01T14:00:00.000Z",
      endTime: "2026-07-01T15:00:00.000Z"
    });
    expect(first.created).toBe(true);
    const second = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: "20260701T140000Z",
      startTime: "2026-07-01T14:00:00.000Z",
      endTime: "2026-07-01T15:00:00.000Z"
    });
    expect(second.created).toBe(false);
    expect(second.occurrence.id).toBe(first.occurrence.id);
    expect((await listOccurrencesForEvent(db, event.id)).length).toBe(1);
  });

  it("reschedules and reports it, but never rewinds an in-progress occurrence", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const occ = await makeOccurrence(db, event.id);

    const moved = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: occ.occurrence_key,
      sequence: 1,
      startTime: "2026-07-01T16:00:00.000Z",
      endTime: "2026-07-01T17:00:00.000Z"
    });
    expect(moved.rescheduled).toBe(true);
    expect(moved.occurrence.start_time).toBe("2026-07-01T16:00:00.000Z");

    await updateOccurrenceStatus(db, occ.id, "in_meeting");
    const blocked = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: occ.occurrence_key,
      sequence: 2,
      startTime: "2026-07-01T18:00:00.000Z",
      endTime: "2026-07-01T19:00:00.000Z"
    });
    expect(blocked.applied).toBe(false);
    expect((await getOccurrence(db, occ.id))?.start_time).toBe("2026-07-01T16:00:00.000Z");
  });

  it("ignores stale occurrence sequences", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const occ = await makeOccurrence(db, event.id);
    await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: occ.occurrence_key,
      sequence: 3,
      startTime: "2026-07-01T16:00:00.000Z",
      endTime: "2026-07-01T17:00:00.000Z"
    });
    const stale = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: occ.occurrence_key,
      sequence: 1,
      startTime: "2026-07-01T10:00:00.000Z",
      endTime: "2026-07-01T11:00:00.000Z"
    });
    expect(stale.applied).toBe(false);
  });

  it("cancels a single occurrence or the whole series and revives on re-invite", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const a = await makeOccurrence(db, event.id, "20260701T140000Z");
    await makeOccurrence(db, event.id, "20260708T140000Z");

    const canceled = await cancelOccurrences(db, event.id, ["20260701T140000Z"]);
    expect(canceled.map((row) => row.id)).toEqual([a.id]);
    expect((await getOccurrence(db, a.id))?.status).toBe("canceled");

    const revived = await upsertOccurrence(db, {
      eventId: event.id,
      occurrenceKey: "20260701T140000Z",
      sequence: 5,
      startTime: "2026-07-01T14:00:00.000Z",
      endTime: "2026-07-01T15:00:00.000Z"
    });
    expect(revived.occurrence.status).toBe("scheduled");

    const all = await cancelOccurrences(db, event.id);
    expect(all.length).toBe(2);
  });

  it("prunes future rule-generated occurrences no longer produced by the series", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    await makeOccurrence(db, event.id, "20990701T140000Z");
    const kept = await makeOccurrence(db, event.id, "20990708T140000Z");
    const pruned = await pruneObsoleteOccurrences(db, event.id, new Set(["20990708T140000Z"]), pastIso);
    expect(pruned.length).toBe(1);
    expect((await getOccurrence(db, kept.id))?.status).toBe("scheduled");
  });
});

describe("bot session queries", () => {
  it("allows only one active session per occurrence", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const occ = await makeOccurrence(db, event.id);
    const session = await createBotSession(db, occ.id, 1);
    expect(session).not.toBeNull();
    expect(await createBotSession(db, occ.id, 2)).toBeNull();

    await updateBotSessionState(db, session!.id, { state: "failed", failureStage: "lobby_timeout", failureReason: "timed out" });
    const retry = await createBotSession(db, occ.id, 2);
    expect(retry).not.toBeNull();
    expect((await getActiveBotSession(db, occ.id))?.id).toBe(retry!.id);
  });

  it("deduplicates bot events by idempotency key and finds stale sessions", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const occ = await makeOccurrence(db, event.id);
    const session = await createBotSession(db, occ.id, 1);
    const first = await insertBotEvent(db, { botSessionId: session!.id, eventType: "state_change", state: "joined", idempotencyKey: "k1" });
    expect(first).not.toBeNull();
    expect(await insertBotEvent(db, { botSessionId: session!.id, eventType: "state_change", state: "joined", idempotencyKey: "k1" })).toBeNull();

    const stale = await listStaleBotSessions(db, futureIso);
    expect(stale.map((row) => row.id)).toContain(session!.id);
    expect(await listStaleBotSessions(db, pastIso)).toEqual([]);
  });
});

describe("job queries", () => {
  it("creates idempotently and leases atomically", async () => {
    const db = createMigratedD1();
    const job = await createJob(db, { type: "schedule_join", idempotencyKey: "join:occ1:1", nextRunAt: pastIso });
    expect(job).not.toBeNull();
    expect(await createJob(db, { type: "schedule_join", idempotencyKey: "join:occ1:1", nextRunAt: pastIso })).toBeNull();

    const lease = await leaseJob(db, job!.id, 60);
    expect(lease).not.toBeNull();
    expect(lease!.job.attempts).toBe(1);
    // Second consumer cannot steal a live lease.
    expect(await leaseJob(db, job!.id, 60)).toBeNull();
    expect(await completeJob(db, job!.id, lease!.leaseId)).toBe(true);
    expect(await leaseJob(db, job!.id, 60)).toBeNull();
  });

  it("does not lease jobs before next_run_at", async () => {
    const db = createMigratedD1();
    const job = await createJob(db, { type: "transcribe", idempotencyKey: "t1", nextRunAt: futureIso });
    expect(await leaseJob(db, job!.id, 60)).toBeNull();
    expect(await listDueJobs(db)).toEqual([]);
  });

  it("recovers expired leases", async () => {
    const db = createMigratedD1();
    const job = await createJob(db, { type: "transcribe", idempotencyKey: "t2", nextRunAt: pastIso });
    const lease = await leaseJob(db, job!.id, -10);
    expect(lease).not.toBeNull();
    const due = await listDueJobs(db);
    expect(due.map((row) => row.id)).toContain(job!.id);
    const second = await leaseJob(db, job!.id, 60);
    expect(second).not.toBeNull();
    // The dead consumer's lease no longer completes the job.
    expect(await completeJob(db, job!.id, lease!.leaseId)).toBe(false);
    expect(await completeJob(db, job!.id, second!.leaseId)).toBe(true);
  });

  it("routes failures to retry, dead letter, and terminal states", async () => {
    const db = createMigratedD1();
    const job = await createJob(db, { type: "generate_recap", idempotencyKey: "r1", nextRunAt: pastIso, maxAttempts: 2 });

    const lease1 = await leaseJob(db, job!.id, 60);
    expect(await failJob(db, job!.id, lease1!.leaseId, { error: "rate limited", retryable: true, nextRunAt: pastIso })).toBe("retry_scheduled");

    const lease2 = await leaseJob(db, job!.id, 60);
    expect(await failJob(db, job!.id, lease2!.leaseId, { error: "rate limited", retryable: true, nextRunAt: pastIso })).toBe("dead_letter");

    const requeued = await requeueJob(db, job!.id);
    expect(requeued?.status).toBe("pending");
    const lease3 = await leaseJob(db, job!.id, 60);
    expect(await failJob(db, job!.id, lease3!.leaseId, { error: "invalid config", retryable: false })).toBe("failed_terminal");
  });

  it("cancels owner jobs including leased ones", async () => {
    const db = createMigratedD1();
    const job = await createJob(db, {
      type: "schedule_join",
      idempotencyKey: "join:occX",
      ownerType: "occurrence",
      ownerId: "occX",
      nextRunAt: pastIso
    });
    const lease = await leaseJob(db, job!.id, 60);
    expect(await cancelJobsForOwner(db, "occurrence", "occX")).toBe(1);
    expect(await completeJob(db, job!.id, lease!.leaseId)).toBe(false);
  });

  it("computes exponential backoff", () => {
    const first = new Date(computeBackoffIso(1, 60)).getTime() - Date.now();
    const third = new Date(computeBackoffIso(3, 60)).getTime() - Date.now();
    expect(first).toBeGreaterThan(50_000);
    expect(first).toBeLessThan(70_000);
    expect(third).toBeGreaterThan(230_000);
    expect(third).toBeLessThan(250_000);
  });
});

describe("inbound message queries", () => {
  it("deduplicates by content hash and records resolution", async () => {
    const db = createMigratedD1();
    const message = await createInboundMessage(db, { contentHash: "hash-1", rawR2Key: "raw-invites/x.eml", fromEmail: "a@b.com" });
    expect(message).not.toBeNull();
    expect(await createInboundMessage(db, { contentHash: "hash-1", rawR2Key: "raw-invites/y.eml" })).toBeNull();

    await resolveInboundMessage(db, message!.id, { parseStatus: "parsed", icsUid: "uid-1", icsMethod: "REQUEST", icsSequence: 0, eventId: "evt_1" });
    const saved = await getInboundMessage(db, message!.id);
    expect(saved?.parse_status).toBe("parsed");
    expect(saved?.ics_uid).toBe("uid-1");
  });
});

describe("settings queries", () => {
  it("persists settings and mirrors the domain allowlist", async () => {
    const db = createMigratedD1();
    expect(await getSettings(db)).toEqual(defaultSettings);

    const saved = await saveSettings(db, {
      ...defaultSettings,
      allowedDomains: ["AcMe.COM", "sub.acme.com"],
      policy: { ...defaultSettings.policy, allowSubdomains: true }
    });
    expect(saved.allowedDomains).toEqual(["acme.com", "sub.acme.com"]);

    const domains = await listAllowedDomains(db);
    expect(domains.map((row) => row.domain)).toEqual(["acme.com", "sub.acme.com"]);
    expect(domains.every((row) => row.allow_subdomains === 1)).toBe(true);
  });
});

describe("pipeline rows", () => {
  it("tracks transcript and recap rows per occurrence with delivery upserts", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const occ = await makeOccurrence(db, event.id);

    const transcript = await ensureTranscript(db, occ.id);
    expect((await ensureTranscript(db, occ.id)).id).toBe(transcript.id);
    await updateTranscript(db, transcript.id, { status: "completed", provider: "openai-whisper", model: "whisper-1", incrementAttempts: true });
    const savedTranscript = await getTranscriptForOccurrence(db, occ.id);
    expect(savedTranscript?.status).toBe("completed");
    expect(savedTranscript?.attempts).toBe(1);

    const recap = await ensureRecap(db, occ.id);
    const sent = await upsertEmailDelivery(db, {
      recapId: recap.id,
      occurrenceId: occ.id,
      recipientEmail: "user@company.com",
      recipientDomain: "company.com",
      status: "sent",
      providerMessageId: "pm-1"
    });
    expect(sent.status).toBe("sent");
    // A retry for the same recipient updates the row instead of duplicating it.
    await upsertEmailDelivery(db, {
      recapId: recap.id,
      occurrenceId: occ.id,
      recipientEmail: "user@company.com",
      recipientDomain: "company.com",
      status: "sent",
      providerMessageId: "pm-2"
    });
    const deliveries = await listDeliveriesForRecap(db, recap.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].provider_message_id).toBe("pm-2");
  });

  it("stores attendees at series level with occurrence overrides", async () => {
    const db = createMigratedD1();
    const event = await makeEvent(db);
    const occ = await makeOccurrence(db, event.id);
    await replaceAttendees(db, event.id, null, [
      { email: "in@company.com", domain: "company.com", isExternal: false, recipientEligible: true },
      { email: "out@other.com", domain: "other.com", isExternal: true, recipientEligible: false, exclusionReason: "external_domain" }
    ]);
    let effective = await listEffectiveAttendees(db, event.id, occ.id);
    expect(effective.length).toBe(2);
    expect(effective.find((row) => row.email === "out@other.com")?.recipient_eligible).toBe(0);

    await replaceAttendees(db, event.id, occ.id, [{ email: "solo@company.com", domain: "company.com", isExternal: false, recipientEligible: true }]);
    effective = await listEffectiveAttendees(db, event.id, occ.id);
    expect(effective.map((row) => row.email)).toEqual(["solo@company.com"]);
  });

  it("upserts artifacts by r2 key and lists expired ones", async () => {
    const db = createMigratedD1();
    const artifact = await upsertArtifact(db, {
      ownerType: "occurrence",
      ownerId: "occ_1",
      kind: "recording",
      r2Key: "recordings/occ_1/recording.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 1024,
      expiresAt: pastIso
    });
    const again = await upsertArtifact(db, {
      ownerType: "occurrence",
      ownerId: "occ_1",
      kind: "recording",
      r2Key: "recordings/occ_1/recording.mp3",
      contentType: "audio/mpeg",
      sizeBytes: 2048
    });
    expect(again.id).toBe(artifact.id);
    expect(again.size_bytes).toBe(2048);

    const expired = await listExpiredArtifacts(db, "2021-01-01T00:00:00.000Z");
    expect(expired.length).toBe(0);
    const expiredNow = await listExpiredArtifacts(db, "2020-06-01T00:00:00.000Z");
    expect(expiredNow.length).toBe(0);
    const expiredLater = await listExpiredArtifacts(db, "2099-01-01T00:00:00.000Z");
    expect(expiredLater.length).toBe(0);
    // expiresAt was dropped by the second upsert (no expiresAt given).
    const reExpired = await upsertArtifact(db, {
      ownerType: "occurrence",
      ownerId: "occ_1",
      kind: "recording",
      r2Key: "recordings/occ_1/recording.mp3",
      expiresAt: pastIso
    });
    expect(reExpired.expires_at).toBe(pastIso);
    expect((await listExpiredArtifacts(db, "2021-01-01T00:00:00.000Z")).length).toBe(1);
  });
});
