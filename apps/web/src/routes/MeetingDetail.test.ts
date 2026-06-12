import { describe, expect, it } from "vitest";
import { MeetingControls, normalizeBotLogs, normalizeSummaryForDisplay, summarizeArtifacts } from "./MeetingDetail";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotStatePanel } from "../components/BotStatePanel";
import { getRecapEmailDeliveryStatus, RecipientEligibilityTable } from "../components/RecipientEligibilityTable";

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

describe("meeting bot log display", () => {
  it("normalizes meeting bot log webhook events into readable rows", () => {
    expect(
      normalizeBotLogs([
        {
          id: "wh_log_1",
          trigger: "bot_logs.update",
          created_at: "2026-05-10T22:16:18.339Z",
          payload: JSON.stringify({
            data: {
              event_type: "runtime_log",
              level: "info",
              message: "Opening Teams meeting URL",
              state: "joining",
              details: { stage: "browser" },
              timestamp: "2026-05-10T22:16:18.000Z"
            }
          })
        },
        {
          id: "wh_state_1",
          trigger: "bot.state_change",
          payload: JSON.stringify({ data: { new_state: "joining" } })
        }
      ])
    ).toEqual([
      {
        id: "wh_log_1",
        time: "2026-05-10T22:16:18.000Z",
        level: "info",
        state: "joining",
        message: "Opening Teams meeting URL",
        detail: "stage=browser"
      }
    ]);
  });
});

describe("recipient recap delivery status", () => {
  it("uses the latest summary email delivery for each attendee", () => {
    const status = getRecapEmailDeliveryStatus(
      { email: "Peter.Test@company.com" },
      [
        {
          recipient_email: "peter.test@company.com",
          type: "summary",
          status: "failed",
          failure_reason: "SMTP provider failed",
          created_at: "2026-05-08T12:00:00.000Z"
        },
        {
          recipient_email: "peter.test@company.com",
          type: "summary",
          status: "sent",
          created_at: "2026-05-08T12:05:00.000Z"
        }
      ]
    );

    expect(status).toEqual({ label: "Sent", badgeClass: "good" });
  });

  it("renders a recap email status column", () => {
    const html = renderToStaticMarkup(
      React.createElement(RecipientEligibilityTable, {
        attendees: [{ id: "att_1", email: "peter.test@company.com", summary_eligible: 1 }],
        emailDeliveries: [{ recipient_email: "peter.test@company.com", type: "summary", status: "sent", created_at: "2026-05-08T12:05:00.000Z" }]
      })
    );

    expect(html).toContain("Recap email");
    expect(html).toContain("Sent");
  });
});

describe("meeting detail recap display", () => {
  it("normalizes teams-style summary JSON for display", () => {
    const summary = normalizeSummaryForDisplay(
      JSON.stringify({
        meetingType: "weekly_spqrc",
        meetingNotes: [
          {
            heading: "Safety Updates:",
            overview: "Safety was reviewed.",
            items: [{ title: "Incident Review:", detail: "Jenny reviewed safety incidents and corrective actions." }]
          }
        ],
        followUpTasks: [{ title: "Close Corrective Actions:", description: "Close open corrective actions.", owners: ["Jenny"], dueDate: "TBD" }],
        summary: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    );

    expect(summary?.meetingTypeLabel).toBe("Weekly SPQRC");
    expect(summary?.meetingNotes[0].items[0].title).toBe("Incident Review:");
    expect(summary?.followUpTasks[0].owners).toEqual(["Jenny"]);
  });

  it("removes duplicated AI disclaimer text from note overviews", () => {
    const summary = normalizeSummaryForDisplay(
      JSON.stringify({
        meetingType: "general",
        meetingNotes: [
          {
            heading: "Brief meeting recap",
            overview: "Generated by AI. Be sure to check for accuracy.",
            items: [{ title: "What happened", detail: "A short test meeting was captured." }]
          }
        ],
        followUpTasks: []
      })
    );

    expect(summary?.meetingNotes[0].overview).toBe("");
    expect(summary?.meetingNotes[0].items[0].title).toBe("What happened");
  });

  it("keeps substantive note overviews", () => {
    const summary = normalizeSummaryForDisplay(
      JSON.stringify({
        meetingType: "general",
        meetingNotes: [
          {
            heading: "Planning:",
            overview: "The launch path was reviewed.",
            items: [{ title: "Launch:", detail: "The team reviewed launch readiness." }]
          }
        ],
        followUpTasks: []
      })
    );

    expect(summary?.meetingNotes[0].overview).toBe("The launch path was reviewed.");
  });

  it("normalizes legacy summary JSON without teams-style fields", () => {
    const summary = normalizeSummaryForDisplay(
      JSON.stringify({
        summary: ["Discussed launch."],
        decisions: [],
        actionItems: [{ owner: "Alex", task: "Ship release notes.", dueDate: "TBD" }],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    );

    expect(summary?.meetingTypeLabel).toBe("General");
    expect(summary?.legacySections[0]).toEqual({ title: "Summary", items: ["Discussed launch."] });
    expect(summary?.legacySections[1]).toEqual({ title: "Action items", items: ["Alex - Ship release notes. - TBD"] });
  });
});

describe("meeting bot state display", () => {
  it("shows a force end recording control for active meeting bots", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingControls, {
        id: "mtg_1",
        meeting: {
          attendee_bot_id: "bot_1",
          attendee_bot_state: "recording",
          status: "BOT_RECORDING"
        },
        reload: () => undefined,
        setMessage: () => undefined
      })
    );

    expect(html).toContain("Force end recording");
  });

  it("hides the force end recording control after the bot reaches a terminal state", () => {
    const html = renderToStaticMarkup(
      React.createElement(MeetingControls, {
        id: "mtg_1",
        meeting: {
          attendee_bot_id: "bot_1",
          attendee_bot_state: "ended",
          status: "BOT_ENDED"
        },
        reload: () => undefined,
        setMessage: () => undefined
      })
    );

    expect(html).not.toContain("Force end recording");
  });

  it("shows the latest bot error and last event timestamp beside the bot state", () => {
    const html = renderToStaticMarkup(
      React.createElement(BotStatePanel, {
        meeting: {
          attendee_bot_id: "bot_1",
          attendee_bot_state: "joining",
          attendee_transcription_state: "pending",
          attendee_recording_state: "pending",
          attendee_last_event_at: "2026-05-10T07:34:28.951Z",
          latest_error: "Teams pre-join screen did not show a Join now button"
        }
      })
    );

    expect(html).toContain("Last event");
    expect(html).toContain("May 10, 2026");
    expect(html).toContain("Latest error");
    expect(html).toContain("Teams pre-join screen did not show a Join now button");
  });
});
