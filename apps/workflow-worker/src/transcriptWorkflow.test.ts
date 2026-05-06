import { defaultSettings } from "@minutesbot/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAndStoreTranscript } from "./transcriptWorkflow";

const getBotRecording = vi.fn();
const transcribe = vi.fn();

vi.mock("@minutesbot/attendee-client", () => ({
  AttendeeClient: vi.fn(() => ({ getBotRecording, deleteBotData: vi.fn() }))
}));

vi.mock("@minutesbot/summary-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@minutesbot/summary-engine")>()),
  createOpenRouterTranscriptionProvider: vi.fn(() => ({ transcribe }))
}));

class FakeD1 {
  artifacts: unknown[][] = [];
  meetingUpdates: unknown[][] = [];
  auditLogs: unknown[][] = [];

  prepare(sql: string) {
    const db = this;
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values;
        return this;
      },
      async first() {
        if (sql.includes("FROM meetings")) return { id: "mtg_1", attendee_bot_id: "bot_1" };
        if (sql.includes("FROM settings")) {
          return {
            key: "app",
            value: JSON.stringify({
              ...defaultSettings,
              ai: { ...defaultSettings.ai, baseUrl: "https://openrouter.ai/api/v1" }
            }),
            updated_at: "2026-05-04T00:00:00.000Z"
          };
        }
        return null;
      },
      async run() {
        if (sql.includes("INSERT INTO artifacts")) db.artifacts.push(this.values);
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
    transcribe.mockReset();
  });

  it("stores Attendee recording, transcribes through OpenRouter, and queues recap generation", async () => {
    const db = new FakeD1();
    const r2Put = vi.fn(async () => undefined);
    const summaryQueue = { send: vi.fn() };
    getBotRecording.mockResolvedValue({ data: new Uint8Array([1, 2, 3]).buffer, contentType: "audio/mp4", sizeBytes: 3 });
    transcribe.mockResolvedValue({ text: "Alex: hello", usage: { seconds: 2.5 } });

    await fetchAndStoreTranscript(
      {
        DB: db as unknown as D1Database,
        ARTIFACTS: { put: r2Put } as unknown as R2Bucket,
        INVITE_QUEUE: { send: vi.fn() },
        SUMMARY_QUEUE: summaryQueue,
        EMAIL_QUEUE: { send: vi.fn() },
        ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
        API_BASE_URL: "https://minutesbot.wgsglobal.app",
        ATTENDEE_API_KEY: "attendee-key",
        AI_API_KEY: "openrouter-key"
      },
      "mtg_1"
    );

    expect(getBotRecording).toHaveBeenCalledWith("bot_1");
    expect(transcribe).toHaveBeenCalledWith(expect.any(ArrayBuffer), "audio/mp4");
    expect(r2Put).toHaveBeenCalledWith("recordings/mtg_1/recording.mp4", expect.any(ArrayBuffer), expect.any(Object));
    expect(r2Put).toHaveBeenCalledWith("transcripts/mtg_1/transcript.txt", "Alex: hello", expect.any(Object));
    expect(db.artifacts.map((values) => values[2])).toEqual(["recording", "transcript_text", "transcript_json"]);
    expect(summaryQueue.send).toHaveBeenCalledWith({ type: "summarize", meetingId: "mtg_1" });
  });

  it("marks transcript failed when OpenRouter transcription fails", async () => {
    const db = new FakeD1();
    getBotRecording.mockResolvedValue({ data: new Uint8Array([1, 2, 3]).buffer, contentType: "audio/mp4", sizeBytes: 3 });
    transcribe.mockRejectedValue(new Error("STT unavailable"));

    await expect(
      fetchAndStoreTranscript(
        {
          DB: db as unknown as D1Database,
          ARTIFACTS: { put: vi.fn(async () => undefined) } as unknown as R2Bucket,
          INVITE_QUEUE: { send: vi.fn() },
          SUMMARY_QUEUE: { send: vi.fn() },
          EMAIL_QUEUE: { send: vi.fn() },
          ATTENDEE_API_BASE_URL: "https://attendee.wgsglobal.app",
          API_BASE_URL: "https://minutesbot.wgsglobal.app",
          ATTENDEE_API_KEY: "attendee-key",
          AI_API_KEY: "openrouter-key"
        },
        "mtg_1"
      )
    ).rejects.toThrow("STT unavailable");

    expect(db.meetingUpdates.at(-1)?.[0]).toBe("failed");
    expect(db.meetingUpdates.at(-1)?.[1]).toBe("FAILED");
  });
});
