import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@minutesbot/shared";
import {
  getCalendarEventByUid,
  getOccurrence,
  getRecapForOccurrence,
  getTranscriptForOccurrence,
  listAuditLogs,
  listBotSessionsForOccurrence,
  listDeliveriesForOccurrence,
  listJobs,
  listOccurrencesForEvent,
  saveSettings,
  setBotSessionRuntimeId,
  createBotSession
} from "@minutesbot/db";
import { createMigratedD1 } from "../../../tests/d1Sqlite";
import { handleInbound } from "../../email-worker/src/index";
import { handleQueueBatch, sweepDueJobs } from "../../workflow-worker/src/queueConsumers";
import { app } from "./index";
import type { Env } from "./env";

const ADMIN_TOKEN = "e2e-admin-secret";
const BOT_TOKEN = "e2e-bot-token";
const recorder = "notetaker@company.com";

// ---------------------------------------------------------------------------
// End-to-end (fully mocked externally): Teams invite email -> ingestion ->
// occurrence + join job -> simulated bot lifecycle webhooks through the real
// API route -> recording -> mocked Whisper transcript -> mocked GPT recap ->
// recap email delivery records for allowed-domain recipients only.
// ---------------------------------------------------------------------------

function fakeR2() {
  const objects = new Map<string, { body: string | ArrayBuffer }>();
  return {
    objects,
    bucket: {
      async put(key: string, value: string | ArrayBuffer) {
        objects.set(key, { body: value });
      },
      async get(key: string) {
        const entry = objects.get(key);
        if (!entry) return null;
        return {
          body: entry.body,
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

async function makeWorld() {
  const db = createMigratedD1();
  await saveSettings(db, {
    ...defaultSettings,
    companyName: "Company Inc",
    recorderEmail: recorder,
    allowedDomains: ["company.com"],
    email: { ...defaultSettings.email, provider: "cloudflare-email-service", senderEmail: recorder, senderName: "Company Notetaker" }
  });
  const r2 = fakeR2();
  const queue: unknown[] = [];
  const sentEmails: Array<{ to: string; subject: string; html?: string }> = [];
  const env = {
    DB: db,
    ARTIFACTS: r2.bucket,
    JOBS_QUEUE: {
      send: async (message: unknown) => {
        queue.push(message);
      }
    },
    SEND_EMAIL: {
      send: async (message: unknown) => {
        sentEmails.push(message as { to: string; subject: string });
        return { id: `cf-${sentEmails.length}` };
      }
    },
    APP_BASE_URL: "https://app.company.com",
    API_BASE_URL: "https://api.company.com",
    BOT_API_BASE_URL: "https://meeting-api.company.com",
    BOT_INTERNAL_TOKEN: BOT_TOKEN,
    ENVIRONMENT: "test",
    SESSION_SECRET: ADMIN_TOKEN,
    AI_API_KEY: "sk-e2e"
  } as unknown as Env;
  return { db, env, r2, queue, sentEmails };
}

/** Drains queued run_job/sweep messages until the queue is idle. */
async function drainQueue(world: Awaited<ReturnType<typeof makeWorld>>, maxRounds = 20): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    await sweepDueJobs(world.env as never);
    const pending = world.queue.splice(0, world.queue.length);
    if (pending.length === 0) return;
    const seen = new Set<string>();
    const messages = pending
      .filter((message) => {
        const key = JSON.stringify(message);
        if (seen.has(key)) return false;
        seen.add(key);
        return (message as { type: string }).type === "run_job";
      })
      .map((message) => ({ body: message, ack: () => undefined, retry: () => undefined }));
    if (messages.length === 0) continue;
    await handleQueueBatch({ messages }, world.env as never);
  }
}

function inviteEmail(): string {
  const start = futureStamp(2, "140000");
  const end = futureStamp(2, "150000");
  const teamsUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_e2e/0?context=%7b%22Tid%22%3a%22t%22%7d";
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:uid-e2e-series",
    "SEQUENCE:0",
    `DTSTART:${start}`,
    `DTEND:${end}`,
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "SUMMARY:Quarterly planning",
    "ORGANIZER;CN=Boss:mailto:boss@company.com",
    "ATTENDEE;CN=Dev;ROLE=REQ-PARTICIPANT:mailto:dev@company.com",
    "ATTENDEE;CN=Contractor;ROLE=OPT-PARTICIPANT:mailto:contractor@external-vendor.com",
    `DESCRIPTION:Join the call: ${teamsUrl}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  return [
    "From: Boss <boss@company.com>",
    `To: Notetaker <${recorder}>`,
    "Message-ID: <e2e-1@company.com>",
    "Subject: Quarterly planning",
    "MIME-Version: 1.0",
    'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"',
    "",
    ics
  ].join("\r\n");
}

function futureStamp(daysAhead: number, time: string): string {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  return `${date.toISOString().slice(0, 10).replaceAll("-", "")}T${time}Z`;
}

async function postWebhook(world: Awaited<ReturnType<typeof makeWorld>>, payload: Record<string, unknown>): Promise<Response> {
  return app.fetch(
    new Request("https://app.company.com/api/webhooks/bot", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { authorization: `Bearer ${BOT_TOKEN}`, "content-type": "application/json" }
    }),
    world.env
  );
}

function stubAiFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/audio/transcriptions")) {
        return new Response(
          JSON.stringify({
            text: "We agreed to ship the Q3 release on August 1. Dana owns the rollout plan.",
            language: "en",
            duration: 1800,
            segments: [
              { start: 0, end: 12, text: "We agreed to ship the Q3 release on August 1." },
              { start: 12, end: 30, text: "Dana owns the rollout plan." }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    overview: "The team agreed on the Q3 release timeline.",
                    decisions: ["Ship the Q3 release on August 1"],
                    actionItems: [{ task: "Write the rollout plan", owner: "Dana" }],
                    risks: [],
                    openQuestions: [],
                    importantDates: [{ date: "August 1", description: "Q3 release" }],
                    followUps: []
                  })
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response("unexpected fetch in e2e", { status: 500 });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("end to end: invite to recap delivery", () => {
  it("processes a recurring Teams invite through the full pipeline", { timeout: 30_000 }, async () => {
    const world = await makeWorld();
    stubAiFetch();

    // 1. Invite arrives at the recorder mailbox.
    const setReject = vi.fn();
    await handleInbound({ from: "boss@company.com", to: recorder, setReject }, world.env as never, inviteEmail());
    expect(setReject).not.toHaveBeenCalled();

    const event = await getCalendarEventByUid(world.db, "uid-e2e-series");
    expect(event).not.toBeNull();
    expect(event!.is_recurring).toBe(1);
    const occurrences = await listOccurrencesForEvent(world.db, event!.id);
    expect(occurrences.length).toBe(2);
    expect((await listJobs(world.db, { type: "schedule_join", status: "pending" })).length).toBe(2);

    // 2. Simulate the bot runtime lifecycle for the first occurrence: the
    //    schedule_join job is not run (it would call the container); instead
    //    a session is registered and the runtime reports states via the real
    //    webhook endpoint.
    const occurrence = occurrences[0];
    const session = await createBotSession(world.db, occurrence.id, 1);
    await setBotSessionRuntimeId(world.db, session!.id, "rt-e2e-1");
    await world.db
      .prepare("UPDATE meeting_occurrences SET latest_bot_session_id = ?, status = 'join_queued' WHERE id = ?")
      .bind(session!.id, occurrence.id)
      .run();

    let seq = 0;
    const webhook = (state: string, extra: Record<string, unknown> = {}) =>
      postWebhook(world, {
        idempotencyKey: `${session!.id}:state_change:${state}:${seq++}`,
        botSessionId: session!.id,
        runtimeBotId: "rt-e2e-1",
        eventType: "state_change",
        state,
        timestamp: new Date().toISOString(),
        ...extra
      });

    for (const state of ["browser_starting", "prejoin", "waiting_room", "joined", "recording"]) {
      const response = await webhook(state);
      expect(response.status).toBe(200);
    }
    expect((await getOccurrence(world.db, occurrence.id))?.status).toBe("in_meeting");

    // Duplicate delivery of the same webhook is a no-op.
    const duplicate = await postWebhook(world, {
      idempotencyKey: `${session!.id}:state_change:recording:4`,
      botSessionId: session!.id,
      runtimeBotId: "rt-e2e-1",
      eventType: "state_change",
      state: "recording",
      timestamp: new Date().toISOString()
    });
    expect(((await duplicate.json()) as { duplicate?: boolean }).duplicate).toBe(true);

    // 3. Recording uploaded; runtime finishes.
    const recordingKey = `recordings/${occurrence.id}/${session!.id}/recording.mp3`;
    await world.r2.bucket.put(recordingKey, new ArrayBuffer(4096));
    await webhook("uploading");
    const finished = await webhook("post_processing_completed", { recordingKey });
    expect(finished.status).toBe(200);

    const sessions = await listBotSessionsForOccurrence(world.db, occurrence.id);
    expect(sessions[0].state).toBe("post_processing_completed");
    expect((await getOccurrence(world.db, occurrence.id))?.status).toBe("post_meeting");

    // 4. Drain the durable job queue: transcribe -> generate_recap -> send_recap.
    await drainQueue(world);

    const transcript = await getTranscriptForOccurrence(world.db, occurrence.id);
    expect(transcript?.status).toBe("completed");
    expect(transcript?.language).toBe("en");
    expect(world.r2.objects.has(`transcripts/${occurrence.id}/transcript.txt`)).toBe(true);
    expect(world.r2.objects.has(`transcripts/${occurrence.id}/transcript.json`)).toBe(true);

    const recap = await getRecapForOccurrence(world.db, occurrence.id);
    expect(recap?.status).toBe("completed");
    expect(recap?.model).toBe("gpt-5.5");
    expect(world.r2.objects.has(`recaps/${occurrence.id}/recap.html`)).toBe(true);

    // 5. Delivery: only allowed-domain recipients, external attendee excluded.
    const deliveries = await listDeliveriesForOccurrence(world.db, occurrence.id);
    expect(deliveries.map((row) => [row.recipient_email, row.status]).sort()).toEqual([
      ["boss@company.com", "sent"],
      ["dev@company.com", "sent"]
    ]);
    expect(deliveries.find((row) => row.recipient_email.includes("external-vendor.com"))).toBeUndefined();
    expect(world.sentEmails.map((mail) => mail.to).sort()).toEqual(["boss@company.com", "dev@company.com"]);

    expect((await getOccurrence(world.db, occurrence.id))?.status).toBe("completed");
    // The second occurrence of the series is untouched and still scheduled.
    expect((await getOccurrence(world.db, occurrences[1].id))?.status).toBe("scheduled");

    // 6. Audit trail covers the lifecycle.
    const auditTypes = new Set((await listAuditLogs(world.db, { limit: 500 })).map((row) => row.event_type));
    for (const expected of [
      "invite.received",
      "event.created",
      "bot.joined",
      "recording.uploaded",
      "transcription.completed",
      "recap.completed",
      "email.delivered",
      "occurrence.completed"
    ]) {
      expect(auditTypes.has(expected), `missing audit event ${expected}`).toBe(true);
    }

    // 7. Transcript content never landed in D1.
    const transcriptRows = await world.db.prepare("SELECT * FROM transcripts").all();
    expect(JSON.stringify(transcriptRows.results)).not.toContain("Q3 release");
    const recapRows = await world.db.prepare("SELECT * FROM recaps").all();
    expect(JSON.stringify(recapRows.results)).not.toContain("rollout plan");
  });

  it("a bot blocked by sign-in fails the occurrence without retry", async () => {
    const world = await makeWorld();
    stubAiFetch();
    const setReject = vi.fn();
    await handleInbound({ from: "boss@company.com", to: recorder, setReject }, world.env as never, inviteEmail());
    const event = await getCalendarEventByUid(world.db, "uid-e2e-series");
    const occurrence = (await listOccurrencesForEvent(world.db, event!.id))[0];
    const session = await createBotSession(world.db, occurrence.id, 1);
    await setBotSessionRuntimeId(world.db, session!.id, "rt-e2e-2");
    await world.db
      .prepare("UPDATE meeting_occurrences SET latest_bot_session_id = ?, status = 'join_queued', join_attempts = 1 WHERE id = ?")
      .bind(session!.id, occurrence.id)
      .run();

    const response = await postWebhook(world, {
      idempotencyKey: `${session!.id}:state_change:failed:0`,
      botSessionId: session!.id,
      runtimeBotId: "rt-e2e-2",
      eventType: "state_change",
      state: "failed",
      failureStage: "sign_in_required",
      failureReason: "Teams demanded a signed-in account",
      diagnosticsKeys: [`diagnostics/${session!.id}/screenshot.png`],
      timestamp: new Date().toISOString()
    });
    expect(response.status).toBe(200);

    const saved = await getOccurrence(world.db, occurrence.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.last_error).toContain("signed-in account");
    // Sign-in blocks are terminal: no retry join job was created.
    const retryJobs = (await listJobs(world.db, { type: "schedule_join" })).filter((job) =>
      job.idempotency_key.includes("retry")
    );
    expect(retryJobs.length).toBe(0);
  });
});
