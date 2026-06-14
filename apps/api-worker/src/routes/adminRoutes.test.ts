import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import {
  createJob,
  getJob,
  listJobs,
  replaceAttendees,
  saveSettings,
  updateOccurrenceStatus,
  upsertCalendarEvent,
  upsertOccurrence
} from "@minutesbot/db";
import { createMigratedD1 } from "../../../../tests/d1Sqlite";
import { app } from "../index";
import type { Env } from "../env";

const ADMIN_TOKEN = "test-admin-secret";

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeEnv(): Promise<{ env: Env; db: D1Database; queueMessages: unknown[] }> {
  const db = createMigratedD1();
  await saveSettings(db, {
    ...defaultSettings,
    recorderEmail: "notetaker@acme.com",
    allowedDomains: ["acme.com"],
    email: { ...defaultSettings.email, senderEmail: "notetaker@acme.com" }
  });
  const queueMessages: unknown[] = [];
  const r2Objects = new Map<string, string>();
  const env = {
    DB: db,
    ARTIFACTS: {
      put: async (key: string, value: string) => {
        r2Objects.set(key, value);
      },
      get: async (key: string) => {
        const value = r2Objects.get(key);
        if (value === undefined) return null;
        return { body: value, text: async () => value, arrayBuffer: async () => new TextEncoder().encode(value).buffer };
      },
      delete: async (key: string) => {
        r2Objects.delete(key);
      }
    } as unknown as R2Bucket,
    JOBS_QUEUE: {
      send: async (message: unknown) => {
        queueMessages.push(message);
      }
    },
    APP_BASE_URL: "https://app.example.com",
    API_BASE_URL: "https://api.example.com",
    BOT_API_BASE_URL: "https://meeting-api.example.com",
    BOT_INTERNAL_TOKEN: "bot-internal-token",
    ENVIRONMENT: "test",
    SESSION_SECRET: ADMIN_TOKEN
  } as unknown as Env;
  return { env, db, queueMessages };
}

function authed(path: string, init: RequestInit = {}): Request {
  return new Request(`https://app.example.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(init.headers ?? {}) }
  });
}

async function seedOccurrence(db: D1Database, options?: { endInFuture?: boolean }) {
  const future = options?.endInFuture !== false;
  const start = new Date(Date.now() + (future ? 3600_000 : -7200_000)).toISOString();
  const end = new Date(Date.now() + (future ? 7200_000 : -3600_000)).toISOString();
  const { event } = await upsertCalendarEvent(db, {
    icsUid: "uid-api",
    sequence: 0,
    subject: "API test meeting",
    organizerEmail: "boss@acme.com",
    teamsJoinUrl: "https://teams.microsoft.com/l/meetup-join/x/0",
    startTime: start,
    endTime: end
  });
  const { occurrence } = await upsertOccurrence(db, {
    eventId: event.id,
    occurrenceKey: "20990101T000000Z",
    startTime: start,
    endTime: end,
    subject: "API test meeting"
  });
  await replaceAttendees(db, event.id, null, [
    { email: "boss@acme.com", domain: "acme.com", isExternal: false, recipientEligible: true },
    { email: "ext@other.com", domain: "other.com", isExternal: true, recipientEligible: false, exclusionReason: "excluded_external_domain" }
  ]);
  return { event, occurrence };
}

describe("api worker routes", () => {
  it("serves health and ready publicly", async () => {
    const { env } = await makeEnv();
    const health = await app.fetch(new Request("https://app.example.com/api/health"), env);
    expect(health.status).toBe(200);
    const ready = await app.fetch(new Request("https://app.example.com/api/ready"), env);
    expect(ready.status).toBe(200);
    expect((await ready.json()) as { ready: boolean }).toMatchObject({ ready: true });
  });

  it("rejects admin routes without the token", async () => {
    const { env } = await makeEnv();
    const response = await app.fetch(new Request("https://app.example.com/api/events"), env);
    expect(response.status).toBe(401);
  });

  it("returns bot runtime client failures as admin diagnostics", async () => {
    const { env } = await makeEnv();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.BOT_RUNTIME = {
      fetch: async () =>
        new Response(JSON.stringify({ detail: "container boot failed" }), {
          status: 500,
          headers: { "content-type": "application/json" }
        })
    } as unknown as Fetcher;

    const response = await app.fetch(authed("/api/admin/test-bot", { method: "POST" }), env);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "BOT_UPSTREAM_ERROR",
        message: "Meeting bot request failed with 500: container boot failed"
      }
    });
  });

  it("round-trips settings and never exposes secret values", async () => {
    const { env } = await makeEnv();
    const get = await app.fetch(authed("/api/settings"), env);
    expect(get.status).toBe(200);
    const view = (await get.json()) as { settings: typeof defaultSettings; secrets: Record<string, boolean> };
    expect(view.settings.recorderEmail).toBe("notetaker@acme.com");
    expect(view.secrets.sessionSecretConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain(ADMIN_TOKEN);

    const updated = { ...view.settings, companyName: "Acme Industrial" };
    const put = await app.fetch(
      authed("/api/settings", { method: "PUT", body: JSON.stringify(updated), headers: { "content-type": "application/json" } }),
      env
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { settings: { companyName: string } }).settings.companyName).toBe("Acme Industrial");
  });

  it("rejects settings that loosen the delivery policy", async () => {
    const { env } = await makeEnv();
    const view = (await (await app.fetch(authed("/api/settings"), env)).json()) as { settings: typeof defaultSettings };
    const evil = { ...view.settings, policy: { ...view.settings.policy, sendToExternalAttendees: true } };
    const put = await app.fetch(
      authed("/api/settings", { method: "PUT", body: JSON.stringify(evil), headers: { "content-type": "application/json" } }),
      env
    );
    expect(put.status).toBeGreaterThanOrEqual(400);
  });

  it("lists events and returns occurrence detail", async () => {
    const { env, db } = await makeEnv();
    const { event, occurrence } = await seedOccurrence(db);

    const events = await app.fetch(authed("/api/events"), env);
    expect(((await events.json()) as { events: unknown[] }).events.length).toBe(1);

    const eventDetail = await app.fetch(authed(`/api/events/${event.id}`), env);
    const eventBody = (await eventDetail.json()) as { occurrences: unknown[]; attendees: Array<{ email: string }> };
    expect(eventBody.occurrences.length).toBe(1);
    expect(eventBody.attendees.length).toBe(2);

    const detail = await app.fetch(authed(`/api/occurrences/${occurrence.id}`), env);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { occurrence: { id: string }; attendees: unknown[]; deliveries: unknown[] };
    expect(body.occurrence.id).toBe(occurrence.id);
    expect(body.attendees.length).toBe(2);
  });

  it("retry-join creates a job, audits, and refuses past meetings", async () => {
    const { env, db, queueMessages } = await makeEnv();
    const { occurrence } = await seedOccurrence(db);
    await updateOccurrenceStatus(db, occurrence.id, "failed", { lastError: "bot died" });

    const retry = await app.fetch(authed(`/api/occurrences/${occurrence.id}/retry-join`, { method: "POST" }), env);
    expect(retry.status).toBe(200);
    const jobs = await listJobs(db, { type: "schedule_join" });
    expect(jobs.length).toBe(1);
    expect(queueMessages).toContainEqual({ type: "run_job", jobId: jobs[0].id });

    const past = await seedPastOccurrence(db);
    const refused = await app.fetch(authed(`/api/occurrences/${past.id}/retry-join`, { method: "POST" }), env);
    expect(refused.status).toBe(409);
  });

  it("retry-transcription requeues an exhausted job", async () => {
    const { env, db } = await makeEnv();
    const { occurrence } = await seedOccurrence(db);
    const job = await createJob(db, {
      type: "transcribe",
      idempotencyKey: `transcribe:${occurrence.id}`,
      ownerType: "occurrence",
      ownerId: occurrence.id,
      nextRunAt: "2020-01-01T00:00:00.000Z"
    });
    await db.prepare("UPDATE jobs SET status = 'dead_letter' WHERE id = ?").bind(job!.id).run();

    const retry = await app.fetch(authed(`/api/occurrences/${occurrence.id}/retry-transcription`, { method: "POST" }), env);
    expect(retry.status).toBe(200);
    expect((await getJob(db, job!.id))?.status).toBe("pending");
  });

  it("requeues dead-letter jobs from the jobs route and refuses running ones", async () => {
    const { env, db } = await makeEnv();
    const job = await createJob(db, { type: "retention_cleanup", idempotencyKey: "rc:1", nextRunAt: "2020-01-01T00:00:00.000Z" });
    await db.prepare("UPDATE jobs SET status = 'dead_letter' WHERE id = ?").bind(job!.id).run();
    const requeue = await app.fetch(authed(`/api/jobs/${job!.id}/requeue`, { method: "POST" }), env);
    expect(requeue.status).toBe(200);

    const running = await createJob(db, { type: "retention_cleanup", idempotencyKey: "rc:2", nextRunAt: "2020-01-01T00:00:00.000Z" });
    const refused = await app.fetch(authed(`/api/jobs/${running!.id}/requeue`, { method: "POST" }), env);
    expect(refused.status).toBe(409);
  });

  it("serves artifact content only to admins", async () => {
    const { env, db } = await makeEnv();
    const { occurrence } = await seedOccurrence(db);
    await env.ARTIFACTS.put(`transcripts/${occurrence.id}/transcript.txt`, "hello transcript");
    const { upsertArtifact } = await import("@minutesbot/db");
    const artifact = await upsertArtifact(db, {
      ownerType: "occurrence",
      ownerId: occurrence.id,
      kind: "transcript_text",
      r2Key: `transcripts/${occurrence.id}/transcript.txt`,
      contentType: "text/plain; charset=utf-8"
    });

    const unauthorized = await app.fetch(new Request(`https://app.example.com/api/artifacts/${artifact.id}/content`), env);
    expect(unauthorized.status).toBe(401);

    const ok = await app.fetch(authed(`/api/artifacts/${artifact.id}/content`), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("hello transcript");
  });

  it("rejects bot webhooks with bad auth and accepts unknown sessions without erroring", async () => {
    const { env } = await makeEnv();
    const payload = {
      idempotencyKey: "k1",
      botSessionId: "bot_missing",
      runtimeBotId: "rt_1",
      eventType: "state_change",
      state: "joined",
      timestamp: new Date().toISOString()
    };
    const bad = await app.fetch(
      new Request("https://app.example.com/api/webhooks/bot", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" }
      }),
      env
    );
    expect(bad.status).toBe(401);

    const unknown = await app.fetch(
      new Request("https://app.example.com/api/webhooks/bot", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { authorization: "Bearer bot-internal-token", "content-type": "application/json" }
      }),
      env
    );
    expect(unknown.status).toBe(200);
    expect((await unknown.json()) as { ok: boolean }).toMatchObject({ ok: false, reason: "unknown_session" });
  });
});

async function seedPastOccurrence(db: D1Database) {
  const { event } = await upsertCalendarEvent(db, {
    icsUid: "uid-past",
    sequence: 0,
    subject: "Past meeting",
    startTime: new Date(Date.now() - 7200_000).toISOString(),
    endTime: new Date(Date.now() - 3600_000).toISOString()
  });
  const { occurrence } = await upsertOccurrence(db, {
    eventId: event.id,
    occurrenceKey: "20000101T000000Z",
    startTime: new Date(Date.now() - 7200_000).toISOString(),
    endTime: new Date(Date.now() - 3600_000).toISOString()
  });
  return occurrence;
}
