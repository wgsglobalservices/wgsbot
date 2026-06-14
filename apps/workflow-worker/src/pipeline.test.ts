import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import {
  createBotSession,
  createJob,
  getJob,
  getOccurrence,
  getRecapForOccurrence,
  getTranscriptForOccurrence,
  listDeliveriesForRecap,
  listJobs,
  replaceAttendees,
  saveSettings,
  updateOccurrenceStatus,
  upsertArtifact,
  upsertCalendarEvent,
  upsertOccurrence
} from "@minutesbot/db";
import { createMigratedD1 } from "../../../tests/d1Sqlite";
import type { WorkflowEnv } from "./env";
import { runJob } from "./jobRunner";
import { handleQueueBatch, sweepDueJobs } from "./queueConsumers";

function fakeR2() {
  const objects = new Map<string, { body: string | ArrayBuffer; contentType?: string }>();
  return {
    objects,
    bucket: {
      async put(key: string, value: string | ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
        objects.set(key, { body: value, contentType: options?.httpMetadata?.contentType });
      },
      async get(key: string) {
        const entry = objects.get(key);
        if (!entry) return null;
        return {
          async arrayBuffer() {
            return typeof entry.body === "string" ? new TextEncoder().encode(entry.body).buffer : entry.body;
          },
          async text() {
            return typeof entry.body === "string" ? entry.body : new TextDecoder().decode(entry.body);
          }
        };
      },
      async delete(key: string) {
        objects.delete(key);
      }
    } as unknown as R2Bucket
  };
}

async function makeWorld(options?: { emailProvider?: "mock" | "cloudflare-email-service" }) {
  const db = createMigratedD1();
  await saveSettings(db, {
    ...defaultSettings,
    recorderEmail: "notetaker@acme.com",
    allowedDomains: ["acme.com"],
    email: { ...defaultSettings.email, provider: options?.emailProvider ?? "cloudflare-email-service", senderEmail: "notetaker@acme.com" }
  });
  const r2 = fakeR2();
  const queueMessages: unknown[] = [];
  const sentEmails: Array<Record<string, unknown>> = [];
  const env: WorkflowEnv = {
    DB: db,
    ARTIFACTS: r2.bucket,
    JOBS_QUEUE: {
      send: async (message) => {
        queueMessages.push(message);
      }
    },
    BOT_API_BASE_URL: "https://bot.example.com",
    BOT_INTERNAL_TOKEN: "internal-token",
    API_BASE_URL: "https://api.example.com",
    APP_BASE_URL: "https://app.example.com",
    AI_API_KEY: "sk-test",
    SEND_EMAIL: {
      send: async (message) => {
        sentEmails.push(message as Record<string, unknown>);
        return { id: `cf-${sentEmails.length}` };
      }
    }
  };

  const { event } = await upsertCalendarEvent(db, {
    icsUid: "uid-pipeline",
    sequence: 0,
    organizerEmail: "boss@acme.com",
    subject: "Pipeline sync",
    teamsJoinUrl: "https://teams.microsoft.com/l/meetup-join/p/0",
    startTime: "2026-06-12T14:00:00.000Z",
    endTime: "2026-06-12T15:00:00.000Z"
  });
  const { occurrence } = await upsertOccurrence(db, {
    eventId: event.id,
    occurrenceKey: "20260612T140000Z",
    startTime: "2026-06-12T14:00:00.000Z",
    endTime: "2026-06-12T15:00:00.000Z",
    subject: "Pipeline sync"
  });
  await replaceAttendees(db, event.id, null, [
    { email: "boss@acme.com", domain: "acme.com", isExternal: false, recipientEligible: true },
    { email: "dev@acme.com", domain: "acme.com", isExternal: false, recipientEligible: true },
    { email: "vendor@evil.com", domain: "evil.com", isExternal: true, recipientEligible: false, exclusionReason: "excluded_external_domain" }
  ]);
  const session = await createBotSession(db, occurrence.id, 1);
  await updateOccurrenceStatus(db, occurrence.id, "post_meeting", { latestBotSessionId: session!.id });
  await r2.bucket.put(`recordings/${occurrence.id}/${session!.id}/recording.mp3`, new ArrayBuffer(2048));
  await upsertArtifact(db, {
    ownerType: "bot_session",
    ownerId: session!.id,
    kind: "recording",
    r2Key: `recordings/${occurrence.id}/${session!.id}/recording.mp3`,
    contentType: "audio/mpeg"
  });
  return { db, env, r2, occurrence, event, session: session!, queueMessages, sentEmails };
}

const recapJson = {
  overview: "The team discussed the launch.",
  decisions: ["Launch on Friday"],
  actionItems: [{ task: "Send notes", owner: "Dev" }],
  risks: [],
  openQuestions: [],
  importantDates: [],
  followUps: ["Follow up next week"]
};

function stubAiFetch() {
  const calls: Array<{ url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push({ url });
      if (url.includes("/audio/transcriptions")) {
        return new Response(
          JSON.stringify({
            text: "Hello team, we will launch on Friday.",
            language: "en",
            duration: 120,
            segments: [{ start: 0, end: 5, text: "Hello team, we will launch on Friday." }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(recapJson) } }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("post-meeting pipeline", () => {
  it("runs transcribe -> recap -> send and delivers only to allowed domains", async () => {
    const world = await makeWorld();
    const calls = stubAiFetch();

    const transcribeJob = await createJob(world.db, {
      type: "transcribe",
      idempotencyKey: `transcribe:${world.occurrence.id}`,
      ownerType: "occurrence",
      ownerId: world.occurrence.id,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      payload: { occurrenceId: world.occurrence.id }
    });
    expect(await runJob(world.env, transcribeJob!.id)).toBe("completed");

    const transcript = await getTranscriptForOccurrence(world.db, world.occurrence.id);
    expect(transcript?.status).toBe("completed");
    expect(transcript?.provider).toBe("openai-whisper");
    expect(world.r2.objects.has(`transcripts/${world.occurrence.id}/transcript.txt`)).toBe(true);
    expect(calls.some((call) => call.url.includes("/audio/transcriptions"))).toBe(true);

    const recapJobs = await listJobs(world.db, { type: "generate_recap" });
    expect(recapJobs.length).toBe(1);
    expect(await runJob(world.env, recapJobs[0].id)).toBe("completed");
    const recap = await getRecapForOccurrence(world.db, world.occurrence.id);
    expect(recap?.status).toBe("completed");
    expect(world.r2.objects.has(`recaps/${world.occurrence.id}/recap.html`)).toBe(true);

    const sendJobs = await listJobs(world.db, { type: "send_recap" });
    expect(sendJobs.length).toBe(1);
    expect(await runJob(world.env, sendJobs[0].id)).toBe("completed");

    const deliveries = await listDeliveriesForRecap(world.db, recap!.id);
    expect(deliveries.map((row) => [row.recipient_email, row.status]).sort()).toEqual([
      ["boss@acme.com", "sent"],
      ["dev@acme.com", "sent"]
    ]);
    // The external attendee never gets a delivery row, let alone an email.
    expect(deliveries.find((row) => row.recipient_email === "vendor@evil.com")).toBeUndefined();
    expect(world.sentEmails.length).toBe(2);

    const occurrence = await getOccurrence(world.db, world.occurrence.id);
    expect(occurrence?.status).toBe("completed");
  });

  it("marks the occurrence completed_no_eligible_recipients instead of emailing externally", async () => {
    const world = await makeWorld();
    stubAiFetch();
    await replaceAttendees(world.db, world.event.id, null, [
      { email: "vendor@evil.com", domain: "evil.com", isExternal: true, recipientEligible: false, exclusionReason: "excluded_external_domain" }
    ]);
    for (const type of ["transcribe", "generate_recap", "send_recap"] as const) {
      const job = await createJob(world.db, {
        type,
        idempotencyKey: `${type}:${world.occurrence.id}:manual`,
        ownerType: "occurrence",
        ownerId: world.occurrence.id,
        nextRunAt: "2020-01-01T00:00:00.000Z",
        payload: { occurrenceId: world.occurrence.id }
      });
      expect(await runJob(world.env, job!.id)).toBe("completed");
    }
    expect(world.sentEmails.length).toBe(0);
    const occurrence = await getOccurrence(world.db, world.occurrence.id);
    expect(occurrence?.status).toBe("completed_no_eligible_recipients");
  });

  it("retries transcription on transient provider failures, then dead-letters", { timeout: 30_000 }, async () => {
    const world = await makeWorld();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );
    const job = await createJob(world.db, {
      type: "transcribe",
      idempotencyKey: `transcribe:${world.occurrence.id}`,
      ownerType: "occurrence",
      ownerId: world.occurrence.id,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      maxAttempts: 2,
      payload: { occurrenceId: world.occurrence.id }
    });

    expect(await runJob(world.env, job!.id)).toBe("retry_scheduled");
    let saved = await getJob(world.db, job!.id);
    expect(saved?.status).toBe("failed_retryable");

    // Force the retry due now, then exhaust attempts -> dead letter.
    await world.db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").bind("2020-01-01T00:00:00.000Z", job!.id).run();
    expect(await runJob(world.env, job!.id)).toBe("dead_letter");
    saved = await getJob(world.db, job!.id);
    expect(saved?.status).toBe("dead_letter");
    const occurrence = await getOccurrence(world.db, world.occurrence.id);
    expect(occurrence?.status).toBe("failed");
  });

  it("fails terminally when no recording exists", async () => {
    const world = await makeWorld();
    stubAiFetch();
    await world.db.prepare("DELETE FROM artifacts").run();
    const job = await createJob(world.db, {
      type: "transcribe",
      idempotencyKey: `transcribe:${world.occurrence.id}`,
      ownerType: "occurrence",
      ownerId: world.occurrence.id,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      payload: { occurrenceId: world.occurrence.id }
    });
    expect(await runJob(world.env, job!.id)).toBe("failed_terminal");
    const transcript = await getTranscriptForOccurrence(world.db, world.occurrence.id);
    expect(transcript?.status).toBe("failed_terminal");
  });

  it("send retries only the failed recipients", async () => {
    const world = await makeWorld();
    stubAiFetch();
    // Pipeline through recap.
    for (const type of ["transcribe", "generate_recap"] as const) {
      const job = await createJob(world.db, {
        type,
        idempotencyKey: `${type}:${world.occurrence.id}:m`,
        ownerType: "occurrence",
        ownerId: world.occurrence.id,
        nextRunAt: "2020-01-01T00:00:00.000Z",
        payload: { occurrenceId: world.occurrence.id }
      });
      await runJob(world.env, job!.id);
    }
    // First send: binding fails for dev@.
    let failNext = false;
    world.env.SEND_EMAIL = {
      send: async (message) => {
        const to = (message as { to: string }).to;
        if (to === "dev@acme.com" && !failNext) {
          failNext = true;
          throw new Error("temporary smtp outage");
        }
        world.sentEmails.push(message as Record<string, unknown>);
        return { id: "ok" };
      }
    };
    const sendJobs = await listJobs(world.db, { type: "send_recap" });
    expect(await runJob(world.env, sendJobs[0].id)).toBe("retry_scheduled");
    const recap = await getRecapForOccurrence(world.db, world.occurrence.id);
    let deliveries = await listDeliveriesForRecap(world.db, recap!.id);
    expect(deliveries.find((row) => row.recipient_email === "dev@acme.com")?.status).toBe("failed");
    expect(deliveries.find((row) => row.recipient_email === "boss@acme.com")?.status).toBe("sent");
    const sentBefore = world.sentEmails.length;

    await world.db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").bind("2020-01-01T00:00:00.000Z", sendJobs[0].id).run();
    expect(await runJob(world.env, sendJobs[0].id)).toBe("completed");
    deliveries = await listDeliveriesForRecap(world.db, recap!.id);
    expect(deliveries.every((row) => row.status === "sent")).toBe(true);
    // boss@ was not re-sent.
    expect(world.sentEmails.length).toBe(sentBefore + 1);
    expect((await getOccurrence(world.db, world.occurrence.id))?.status).toBe("completed");
  });

  it("sweep enqueues due jobs and the queue consumer runs them", async () => {
    const world = await makeWorld();
    stubAiFetch();
    await createJob(world.db, {
      type: "transcribe",
      idempotencyKey: `transcribe:${world.occurrence.id}`,
      ownerType: "occurrence",
      ownerId: world.occurrence.id,
      nextRunAt: "2020-01-01T00:00:00.000Z",
      payload: { occurrenceId: world.occurrence.id }
    });
    const count = await sweepDueJobs(world.env);
    expect(count).toBe(1);
    const runMessage = world.queueMessages.find((m) => (m as { type: string }).type === "run_job") as { jobId: string };
    expect(runMessage).toBeDefined();

    const acked: boolean[] = [];
    await handleQueueBatch(
      {
        messages: [
          {
            body: runMessage,
            ack: () => acked.push(true),
            retry: () => acked.push(false)
          }
        ]
      },
      world.env
    );
    expect(acked).toEqual([true]);
    expect((await getTranscriptForOccurrence(world.db, world.occurrence.id))?.status).toBe("completed");
  });
});
