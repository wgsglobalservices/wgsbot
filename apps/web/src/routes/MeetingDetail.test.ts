import { describe, expect, it } from "vitest";
import { summarizeArtifacts } from "./MeetingDetail";

describe("meeting artifact summaries", () => {
  it("groups repeated artifact rows and keeps the latest timestamp", () => {
    expect(
      summarizeArtifacts([
        {
          id: "art_1",
          type: "recording",
          r2_key: "recordings/mtg_1/recording.bin",
          content_type: "application/json",
          size_bytes: 412,
          created_at: "2026-05-06T03:52:30.261Z"
        },
        {
          id: "art_2",
          type: "recording",
          r2_key: "recordings/mtg_1/recording.bin",
          content_type: "application/json",
          size_bytes: 412,
          created_at: "2026-05-06T03:52:31.691Z"
        },
        {
          id: "art_3",
          type: "transcript_text",
          r2_key: "transcripts/mtg_1/transcript.txt",
          content_type: "text/plain",
          size_bytes: 28,
          created_at: "2026-05-06T03:53:00.000Z"
        }
      ])
    ).toEqual([
      {
        key: "transcript_text|transcripts/mtg_1/transcript.txt|text/plain|28|active",
        type: "transcript_text",
        path: "transcripts/mtg_1/transcript.txt",
        contentType: "text/plain",
        sizeBytes: 28,
        latestCreatedAt: "2026-05-06T03:53:00.000Z",
        count: 1,
        deleted: false
      },
      {
        key: "recording|recordings/mtg_1/recording.bin|application/json|412|active",
        type: "recording",
        path: "recordings/mtg_1/recording.bin",
        contentType: "application/json",
        sizeBytes: 412,
        latestCreatedAt: "2026-05-06T03:52:31.691Z",
        count: 2,
        deleted: false
      }
    ]);
  });
});
