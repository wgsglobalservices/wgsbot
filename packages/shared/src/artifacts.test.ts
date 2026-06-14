import { describe, expect, it } from "vitest";
import {
  botEventPayloadKey,
  diagnosticsKey,
  rawInviteKey,
  recapHtmlKey,
  recapJsonKey,
  recordingChunkKey,
  recordingKey,
  recordingKeyPattern,
  sha256Hex,
  transcriptJsonKey,
  transcriptTextKey
} from "./artifacts";

describe("artifact keys", () => {
  it("builds canonical keys", () => {
    expect(rawInviteKey("msg_abc", "2026-06-12T10:00:00.000Z")).toBe("raw-invites/2026-06-12/msg_abc.eml");
    expect(recordingKey("occ_1", "bot_2")).toBe("recordings/occ_1/bot_2/recording.mp3");
    expect(recordingChunkKey("occ_1", "bot_2", 7)).toBe("recordings/occ_1/bot_2/chunks/chunk-007.mp3");
    expect(transcriptJsonKey("occ_1")).toBe("transcripts/occ_1/transcript.json");
    expect(transcriptTextKey("occ_1")).toBe("transcripts/occ_1/transcript.txt");
    expect(recapJsonKey("occ_1")).toBe("recaps/occ_1/recap.json");
    expect(recapHtmlKey("occ_1")).toBe("recaps/occ_1/recap.html");
    expect(diagnosticsKey("bot_2", "screenshot.png")).toBe("diagnostics/bot_2/screenshot.png");
    expect(botEventPayloadKey("bot_2", "bev_3")).toBe("bot-events/bot_2/bev_3.json");
  });

  it("rejects path traversal in ids", () => {
    expect(() => recordingKey("../secrets", "bot_2")).toThrow();
    expect(() => recordingKey("occ_1", "bot/2")).toThrow();
    expect(() => rawInviteKey("msg with spaces", "2026-06-12T10:00:00.000Z")).toThrow();
  });

  it("recording key pattern accepts uploads and rejects traversal", () => {
    expect(recordingKeyPattern.test("recordings/occ_1/bot_2/recording.mp3")).toBe(true);
    expect(recordingKeyPattern.test("recordings/occ_1/bot_2/chunks/chunk-001.mp3")).toBe(true);
    expect(recordingKeyPattern.test("recordings/../x/recording.mp3")).toBe(false);
    expect(recordingKeyPattern.test("transcripts/occ_1/transcript.txt")).toBe(false);
    expect(recordingKeyPattern.test("recordings/occ_1/bot_2/recording.exe")).toBe(false);
  });

  it("hashes content deterministically", async () => {
    await expect(sha256Hex("hello")).resolves.toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
