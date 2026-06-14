import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import {
  createJob,
  getActiveBotSession,
  getOccurrence,
  listBotSessionsForOccurrence,
  listJobs,
  saveSettings,
  upsertCalendarEvent,
  upsertOccurrence
} from "@minutesbot/db";
import { createMigratedD1 } from "../../../tests/d1Sqlite";
import type { WorkflowEnv } from "./env";
import { runJob } from "./jobRunner";

async function makeWorld() {
  const db = createMigratedD1();
  await saveSettings(db, {
    ...defaultSettings,
    recorderEmail: "notetaker@acme.com",
    allowedDomains: ["acme.com"],
    email: { ...defaultSettings.email, senderEmail: "notetaker@acme.com" }
  });
  const queue: unknown[] = [];
  const env: WorkflowEnv = {
    DB: db,
    ARTIFACTS: { put: async () => undefined, get: async () => null, delete: async () => undefined } as unknown as R2Bucket,
    JOBS_QUEUE: {
      send: async (message) => {
        queue.push(message);
      }
    },
    BOT_API_BASE_URL: "https://meeting-api.acme.com",
    BOT_INTERNAL_TOKEN: "internal-token",
    API_BASE_URL: "https://api.acme.com",
    AI_API_KEY: "sk-test"
  };
  const start = new Date(Date.now() + 120_000).toISOString();
  const end = new Date(Date.now() + 3_720_000).toISOString();
  const { event } = await upsertCalendarEvent(db, {
    icsUid: "uid-join",
    sequence: 0,
    subject: "Join test",
    teamsJoinUrl: "https://teams.microsoft.com/l/meetup-join/j/0",
    startTime: start,
    endTime: end
  });
  const { occurrence } = await upsertOccurrence(db, {
    eventId: event.id,
    occurrenceKey: "20990601T000000Z",
    startTime: start,
    endTime: end
  });
  return { db, env, occurrence, queue };
}

async function makeJoinJob(db: D1Database, occurrenceId: string) {
  const job = await createJob(db, {
    type: "schedule_join",
    idempotencyKey: `schedule_join:${occurrenceId}`,
    ownerType: "occurrence",
    ownerId: occurrenceId,
    nextRunAt: "2020-01-01T00:00:00.000Z",
    maxAttempts: 2,
    payload: { occurrenceId }
  });
  return job!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("schedule_join handler", () => {
  it("creates a bot session via the runtime and records the runtime bot id", async () => {
    const world = await makeWorld();
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        requests.push({ url: String(input), body });
        return new Response(JSON.stringify({ runtimeBotId: "rt-77", state: "created" }), { status: 201 });
      })
    );

    const job = await makeJoinJob(world.db, world.occurrence.id);
    expect(await runJob(world.env, job.id)).toBe("completed");

    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe("https://meeting-api.acme.com/v1/bots");
    expect(requests[0].body.meetingUrl).toContain("teams.microsoft.com");
    expect(requests[0].body.displayName).toBe(defaultSettings.bot.displayName);
    const upload = requests[0].body.upload as { recordingKey: string };
    expect(upload.recordingKey).toMatch(/^recordings\/occ_[a-f0-9]+\/bot_[a-f0-9]+\/recording\.mp3$/);

    const session = await getActiveBotSession(world.db, world.occurrence.id);
    expect(session?.runtime_bot_id).toBe("rt-77");
    expect((await getOccurrence(world.db, world.occurrence.id))?.status).toBe("join_queued");
    // A monitor job now watches the session.
    expect((await listJobs(world.db, { type: "monitor_bot" })).length).toBe(1);
  });

  it("does not create a second session while one is active", async () => {
    const world = await makeWorld();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ runtimeBotId: "rt-1", state: "created" }), { status: 201 }))
    );
    const first = await makeJoinJob(world.db, world.occurrence.id);
    await runJob(world.env, first.id);

    const second = await createJob(world.db, {
      type: "schedule_join",
      idempotencyKey: `schedule_join:${world.occurrence.id}:again`,
      ownerType: "occurrence",
      ownerId: world.occurrence.id,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      payload: { occurrenceId: world.occurrence.id }
    });
    expect(await runJob(world.env, second!.id)).toBe("completed");
    expect((await listBotSessionsForOccurrence(world.db, world.occurrence.id)).length).toBe(1);
  });

  it("releases the failed session and retries when the runtime is down", async () => {
    const world = await makeWorld();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream unavailable", { status: 503 }))
    );
    const job = await makeJoinJob(world.db, world.occurrence.id);
    expect(await runJob(world.env, job.id)).toBe("retry_scheduled");

    // The session row was failed over so the retry can create a fresh one.
    expect(await getActiveBotSession(world.db, world.occurrence.id)).toBeNull();
    const sessions = await listBotSessionsForOccurrence(world.db, world.occurrence.id);
    expect(sessions[0].state).toBe("failed");
  });

  it("skips occurrences whose meeting window already passed", async () => {
    const world = await makeWorld();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await world.db
      .prepare("UPDATE meeting_occurrences SET start_time = ?, end_time = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", "2020-01-01T01:00:00.000Z", world.occurrence.id)
      .run();
    const job = await makeJoinJob(world.db, world.occurrence.id);
    expect(await runJob(world.env, job.id)).toBe("completed");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getOccurrence(world.db, world.occurrence.id))?.status).toBe("skipped");
  });
});
