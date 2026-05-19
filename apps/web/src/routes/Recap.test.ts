import { describe, expect, it } from "vitest";
import { defaultSettings, type AppSettings } from "@minutesbot/shared";
import React from "react";
import { File as NodeFile } from "node:buffer";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Recap,
  buildUploadedTranscriptRecapPayload,
  fileToTranscriptText,
  loadUploadedTranscriptRecapDraft,
  saveUploadedTranscriptRecapDraft,
  toApiMeetingStartTime
} from "./Recap";

describe("uploaded transcript recap test helpers", () => {
  it("saves and reloads the uploaded transcript recap draft", () => {
    const storage = new Map<string, string>();
    const draft = {
      recipient: "Reviewer@Example.COM",
      subject: "Weekly Sales",
      meetingStartTime: "2026-05-19T01:02",
      organizerEmail: "Owner@WGS.Bot",
      organizerName: "Owner",
      transcriptText: "WEBVTT\n\nAlex: pipeline update"
    };

    saveUploadedTranscriptRecapDraft(draft, {
      setItem(key, value) {
        storage.set(key, value);
      }
    });

    expect(
      loadUploadedTranscriptRecapDraft("fallback@example.com", () => "2026-05-19T02:00", {
        getItem(key) {
          return storage.get(key) ?? null;
        }
      })
    ).toEqual(draft);
  });

  it("falls back to defaults when the uploaded transcript recap draft is invalid", () => {
    expect(
      loadUploadedTranscriptRecapDraft("fallback@example.com", () => "2026-05-19T02:00", {
        getItem() {
          return "{";
        }
      })
    ).toEqual({
      recipient: "fallback@example.com",
      subject: "",
      meetingStartTime: "2026-05-19T02:00",
      organizerEmail: "",
      organizerName: "",
      transcriptText: ""
    });
  });

  it("builds the uploaded transcript recap payload with normalized recipient and organizer email", () => {
    expect(
      buildUploadedTranscriptRecapPayload({
        recipient: " Reviewer@Example.COM ",
        subject: " Old meeting ",
        meetingStartTime: "2026-05-07T10:00",
        organizerEmail: " Owner@WGS.Bot ",
        organizerName: " Owner ",
        transcriptText: " Alex: hello "
      })
    ).toEqual({
      recipient: "reviewer@example.com",
      subject: "Old meeting",
      meetingStartTime: "2026-05-07T14:00:00.000Z",
      organizerEmail: "owner@wgs.bot",
      organizerName: "Owner",
      transcriptText: "Alex: hello"
    });
  });

  it("converts local datetime input to an API timestamp", () => {
    expect(toApiMeetingStartTime("2026-05-07T10:00")).toBe("2026-05-07T14:00:00.000Z");
    expect(toApiMeetingStartTime("")).toBe("");
  });

  it("reads uploaded transcript text files", async () => {
    const file = new NodeFile(["Alex: uploaded transcript"], "meeting.txt", { type: "text/plain" }) as unknown as File;

    await expect(fileToTranscriptText(file)).resolves.toBe("Alex: uploaded transcript");
  });

  it("renders the uploaded transcript recap test panel on the Recap page", () => {
    const html = renderToStaticMarkup(
      React.createElement(Recap as React.ComponentType<{ initialSettings: AppSettings; saveSettingsOverride: (settings: AppSettings) => Promise<AppSettings> }>, {
        initialSettings: defaultSettings,
        saveSettingsOverride: async (settings: AppSettings) => settings
      })
    );

    expect(html).toContain("Test recap from transcript");
    expect(html).toContain("Upload transcript");
    expect(html).toContain("Paste transcript");
    expect(html).toContain("Send test recap");
  });
});
