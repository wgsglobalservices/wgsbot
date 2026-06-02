import { defaultSettings } from "@minutesbot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateAndStoreTranscript } from "./transcriptWorkflow";
import type { WorkflowEnv } from "./env";

const getBotRecording = vi.fn();
const getBotTranscript = vi.fn();
const deleteBotData = vi.fn();
const transcribe = vi.fn();

vi.mock("@minutesbot/attendee-client", () => ({
  AttendeeClient: vi.fn(() => ({ getBotRecording, getBotTranscript, deleteBotData }))
}));

vi.mock("@minutesbot/summary-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@minutesbot/summary-engine")>()),
  createOpenRouterTranscriptionProvider: vi.fn(() => ({ transcribe }))
}));

type ArtifactRow = {
  id: string;
  meeting_id: string;
  type: string;
  r2_key: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
  deleted_at: string | null;
};

class FakeD1 {
  artifacts: unknown[][] = [];
  artifactUpdates: unknown[][] = [];
  meetingUpdates: unknown[][] = [];
  auditLogs: unknown[][] = [];
  existingArtifacts = new Map<string, ArtifactRow>();
  meeting = { id: "mtg_1", attendee_bot_id: "bot_1" };
  transcriptSegments: Array<Record<string, unknown>> = [];
  settings = {
    ...defaultSettings,
    ai: { ...defaultSettings.ai, baseUrl: "https://openrouter.ai/api/v1" }
  };

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings")) return db.meeting;
        if (sql.includes("FROM settings")) {
          return {
            key: "app",
            value: JSON.stringify(db.settings),
            updated_at: "2026-05-04T00:00:00.000Z"
          };
        }
        if (sql.includes("FROM artifacts")) return db.existingArtifacts.get(artifactKey(this.values[0], this.values[1], this.values[2])) ?? null;
        return null;
      },
      async all<T>() {
        if (sql.includes("FROM transcript_segments")) return { results: db.transcriptSegments as T[] };
        return { results: [] as T[] };
      },
      async run() {
        if (sql.includes("INSERT INTO artifacts")) db.artifacts.push(this.values);
        if (sql.startsWith("UPDATE artifacts SET")) db.artifactUpdates.push(this.values);
        if (sql.includes("UPDATE meetings SET transcript_status")) db.meetingUpdates.push(this.values);
        if (sql.includes("INSERT INTO audit_logs")) db.auditLogs.push(this.values);
        return { success: true };
      }
    };
  }
}

describe("transcript workflow", () => {
  beforeEach(() => {
    getBotRecording.mockReset();
    getBotTranscript.mockReset();
    deleteBotData.mockReset();
    transcribe.mockReset();
  });

  it("transcribes the expected R2 MP3 without calling Attendee transcript or recording endpoints", async () => {
    const db = new FakeD1();
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const artifacts = r2WithRecording(audio);
    const summaryQueue = { send: vi.fn() };
    transcribe.mockResolvedValue({ text: "Alex: hello", usage: { seconds: 2.5 } });

    await generateAndStoreTranscript(env(db, artifacts, summaryQueue), "mtg_1");

    expect(getBotTranscript).not.toHaveBeenCalled();
    expect(getBotRecording).not.toHaveBeenCalled();
    expect(artifacts.get).toHaveBeenCalledWith("recordings/mtg_1/recording.mp3");
    expect(transcribe).toHaveBeenCalledWith(audio, "audio/mpeg");
    expect(artifacts.put).toHaveBeenCalledWith("transcripts/mtg_1/transcript.txt", "Alex: hello", expect.any(Object));
    expect(db.artifacts.map((values) => values[2])).toEqual(["recording", "transcript_text", "transcript_json"]);
    expect(summaryQueue.send).toHaveBeenCalledWith({ type: "summarize", meetingId: "mtg_1" });
  });

  it("generates transcript artifacts from the recording even when Attendee webhook segments exist", async () => {
    const db = new FakeD1();
    db.transcriptSegments = [
      { speaker_name: "Casey", timestamp_ms: 2000, duration_ms: 500, text: "Second update." },
      { speaker_name: "Alex", timestamp_ms: 1000, duration_ms: 500, text: "First update." },
      { speaker_name: "", timestamp_ms: 3000, duration_ms: 500, text: "  " }
    ];
    const audio = new Uint8Array([1, 2, 3]).buffer;
    const artifacts = r2WithRecording(audio);
    const summaryQueue = { send: vi.fn() };
    transcribe.mockResolvedValue({ text: "Whisper-generated transcript.", usage: { seconds: 4 } });

    await generateAndStoreTranscript(env(db, artifacts, summaryQueue), "mtg_1");

    expect(transcribe).toHaveBeenCalledWith(audio, "audio/mpeg");
    expect(artifacts.put).toHaveBeenCalledWith("transcripts/mtg_1/transcript.txt", "Whisper-generated transcript.", expect.any(Object));
    expect(artifacts.put).toHaveBeenCalledWith("transcripts/mtg_1/transcript.json", expect.stringContaining("\"source\":\"openrouter\""), expect.any(Object));
    expect(artifacts.put).toHaveBeenCalledWith("transcripts/mtg_1/transcript.json", expect.not.stringContaining("Alex: First update."), expect.any(Object));
    expect(db.meetingUpdates.at(-1)?.[0]).toBe("complete");
    expect(db.meetingUpdates.at(-1)?.[1]).toBe("TRANSCRIPT_AVAILABLE");
    expect(summaryQueue.send).toHaveBeenCalledWith({ type: "summarize", meetingId: "mtg_1" });
  });

  it("requeues with delay while the expected R2 recording is missing", async () => {
    const db = new FakeD1();
    const artifacts = r2WithoutRecording();
    const summaryQueue = { send: vi.fn() };

    await generateAndStoreTranscript(env(db, artifacts, summaryQueue), "mtg_1");

    expect(summaryQueue.send).toHaveBeenCalledWith({ type: "generate_transcript", meetingId: "mtg_1", botId: "bot_1", attempt: 1 }, { delaySeconds: 60 });
    expect(db.meetingUpdates).toEqual([]);
    expect(db.auditLogs.map((values) => values[2])).toContain("transcript.recording_pending");
    expect(db.auditLogs.map((values) => values[2])).not.toContain("transcript.failed");
    expect(db.artifacts).toEqual([]);
  });

  it("marks transcript unavailable after the final missing-recording attempt", async () => {
    const db = new FakeD1();
    const artifacts = r2WithoutRecording();
    const summaryQueue = { send: vi.fn() };

    await generateAndStoreTranscript(env(db, artifacts, summaryQueue), "mtg_1", undefined, undefined, { attempt: 10 });

    expect(summaryQueue.send).not.toHaveBeenCalled();
    expect(db.meetingUpdates.at(-1)?.[0]).toBe("unavailable");
    expect(db.meetingUpdates.at(-1)?.[1]).toBe("NO_TRANSCRIPT_AVAILABLE");
    expect(db.auditLogs.map((values) => values[2])).toContain("transcript.unavailable");
  });

  it("updates the existing recording artifact instead of inserting duplicate recording rows", async () => {
    const db = new FakeD1();
    db.existingArtifacts.set(artifactKey("mtg_1", "recording", "recordings/mtg_1/recording.mp3"), {
      id: "art_1",
      meeting_id: "mtg_1",
      type: "recording",
      r2_key: "recordings/mtg_1/recording.mp3",
      content_type: "audio/mpeg",
      size_bytes: 1,
      created_at: "2026-05-04T00:00:00.000Z",
      deleted_at: null
    });
    const artifacts = r2WithRecording(new Uint8Array([1, 2, 3]).buffer);
    transcribe.mockResolvedValue({ text: "Alex: hello", usage: null });

    await generateAndStoreTranscript(env(db, artifacts, { send: vi.fn() }), "mtg_1");

    expect(db.artifacts.map((values) => values[2])).toEqual(["transcript_text", "transcript_json"]);
    expect(db.artifactUpdates.at(0)).toEqual(["audio/mpeg", 3, "art_1"]);
  });
});

function env(db: FakeD1, artifacts: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }, summaryQueue: { send: ReturnType<typeof vi.fn> }): WorkflowEnv {
  return {
    DB: db as unknown as D1Database,
    ARTIFACTS: artifacts as unknown as R2Bucket,
    INVITE_QUEUE: { send: vi.fn() },
    SUMMARY_QUEUE: summaryQueue,
    EMAIL_QUEUE: { send: vi.fn() },
    ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
    API_BASE_URL: "https://minutesbot-api.wgsglobal.app",
    ATTENDEE_API_KEY: "attendee-key",
    ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME: "minutesbot-artifacts",
    AI_API_KEY: "openrouter-key"
  };
}

function r2WithRecording(data: ArrayBuffer, contentType = "audio/mpeg") {
  return {
    get: vi.fn(async (key: string) => (key === "recordings/mtg_1/recording.mp3" ? r2Object(data, contentType) : null)),
    put: vi.fn(async () => undefined)
  };
}

function r2WithoutRecording() {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined)
  };
}

function r2Object(data: ArrayBuffer, contentType?: string): R2ObjectBody {
  return {
    key: "recordings/mtg_1/recording.mp3",
    size: data.byteLength,
    httpMetadata: contentType ? { contentType } : undefined,
    arrayBuffer: async () => data
  } as R2ObjectBody;
}

function artifactKey(meetingId: unknown, type: unknown, r2Key: unknown): string {
  return `${String(meetingId)}|${String(type)}|${String(r2Key)}`;
}
