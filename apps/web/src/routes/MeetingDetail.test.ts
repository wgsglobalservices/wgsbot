import { describe, expect, it } from "vitest";
import { formatMeetingSchedule, meetingRecapRecipientOptions, normalizeSummaryForDisplay, summarizeArtifacts } from "./MeetingDetail";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

describe("recipient recap delivery status", () => {
  it("uses the latest summary email delivery for each attendee", () => {
    const status = getRecapEmailDeliveryStatus(
      { email: "Peter.Test@wgsglobalservices.com" },
      [
        {
          recipient_email: "peter.test@wgsglobalservices.com",
          type: "summary",
          status: "failed",
          failure_reason: "SMTP provider failed",
          created_at: "2026-05-08T12:00:00.000Z"
        },
        {
          recipient_email: "peter.test@wgsglobalservices.com",
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
        attendees: [{ id: "att_1", email: "peter.test@wgsglobalservices.com", summary_eligible: 1 }],
        emailDeliveries: [{ recipient_email: "peter.test@wgsglobalservices.com", type: "summary", status: "sent", created_at: "2026-05-08T12:05:00.000Z" }]
      })
    );

    expect(html).toContain("Recap email");
    expect(html).toContain("Sent");
  });
});

describe("manual meeting recap recipients", () => {
  it("builds a deduped organizer and attendee email list for manual sends", () => {
    expect(
      meetingRecapRecipientOptions("Owner@WGS.Bot", [
        { email: "alex@wgs.bot" },
        { email: "owner@wgs.bot" },
        { email: "" }
      ])
    ).toEqual(["owner@wgs.bot", "alex@wgs.bot"]);
  });
});

describe("meeting detail schedule display", () => {
  it("formats the meeting schedule with start time, end time, and duration", () => {
    const schedule = formatMeetingSchedule({
      start_time: "2026-05-04T15:00:00.000Z",
      end_time: "2026-05-04T15:30:00.000Z"
    });

    expect(schedule).toContain("May 4, 2026");
    expect(schedule).toContain("30 minutes");
    expect(schedule).toMatch(/\d{1,2}:00\s?(AM|PM)/i);
    expect(schedule).toMatch(/\d{1,2}:30\s?(AM|PM)/i);
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
