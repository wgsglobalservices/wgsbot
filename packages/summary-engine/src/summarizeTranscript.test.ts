import { describe, expect, it } from "vitest";
import {
  buildSummaryPrompt,
  chunkTranscript,
  classifyMeetingAcrossTranscript,
  meetingSummarySchema,
  resolveMeetingType,
  summarizeTranscript
} from "./index";

describe("summary engine", () => {
  it("chunks long transcripts", () => {
    expect(chunkTranscript("a".repeat(25), 10)).toHaveLength(3);
  });

  it("validates and returns strict summary JSON from a provider", async () => {
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Project sync",
        attendees: [{ email: "alex@company.com" }],
        transcriptText: "Alice: We decided to launch Friday."
      },
      {
        async generate() {
          return {
            meetingType: "general",
            summary: ["Launch timing was discussed."],
            decisions: ["Launch Friday."],
            actionItems: [],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(summary.decisions).toEqual(["Launch Friday."]);
    expect(summary.actionItems).toEqual([]);
    expect(summary.meetingType).toBe("general");
  });

  it("classifies weekly SPQRC meetings from title and transcript signals", async () => {
    const result = await classifyMeetingAcrossTranscript(
      {
        meetingSubject: "Weekly SPQRC",
        attendees: [],
        transcriptText: "Safety incidents, people staffing, quality defects, delivery backlog, and cost overtime were reviewed."
      },
      {
        async generate() {
          return { meetingType: "weekly_spqrc", confidence: 0.92, signals: ["SPQRC", "safety", "cost"], reason: "SPQRC review" };
        }
      }
    );

    expect(result.meetingType).toBe("weekly_spqrc");
  });

  it("classifies weekly sales meetings from commercial transcript signals", async () => {
    const result = await classifyMeetingAcrossTranscript(
      {
        meetingSubject: "Weekly Sales",
        attendees: [],
        transcriptText: "Pipeline forecast, CRM updates, customer quotes, pricing, revenue, and wins were discussed."
      },
      {
        async generate() {
          return { meetingType: "weekly_sales", confidence: 0.89, signals: ["pipeline", "forecast", "quotes"], reason: "Sales review" };
        }
      }
    );

    expect(result.meetingType).toBe("weekly_sales");
  });

  it("classifies plant-specific production meetings as plant meetings", async () => {
    const result = await classifyMeetingAcrossTranscript(
      {
        meetingSubject: "Detroit plant production meeting",
        attendees: [],
        transcriptText: "Detroit plant staffing, production schedule, shipments, downtime, maintenance, materials, and inventory were reviewed."
      },
      {
        async generate() {
          return { meetingType: "plant_meeting", confidence: 0.84, signals: ["Detroit plant", "production"], reason: "Plant-specific operations" };
        }
      }
    );

    expect(result.meetingType).toBe("plant_meeting");
  });

  it("classifies generic and low-confidence meetings as general", async () => {
    const generic = await classifyMeetingAcrossTranscript(
      { meetingSubject: "Project status", attendees: [], transcriptText: "The team reviewed milestones and next documentation steps." },
      {
        async generate() {
          return { meetingType: "general", confidence: 0.7, signals: ["status"], reason: "Generic status meeting" };
        }
      }
    );
    const lowConfidence = resolveMeetingType(
      [{ meetingType: "weekly_sales", confidence: 0.28, signals: ["customer"], reason: "Weak customer mention" }],
      { meetingSubject: "Touch base", transcriptText: "A customer was mentioned briefly." }
    );

    expect(generic.meetingType).toBe("general");
    expect(lowConfidence.meetingType).toBe("general");
  });

  it("prefers SPQRC over plant meeting when plant-specific SPQRC structure is clear", () => {
    const result = resolveMeetingType(
      [
        { meetingType: "plant_meeting", confidence: 0.8, signals: ["Detroit plant"], reason: "Plant name" },
        { meetingType: "weekly_spqrc", confidence: 0.78, signals: ["safety", "people", "quality", "delivery", "cost"], reason: "SPQRC categories" }
      ],
      {
        meetingSubject: "Detroit Plant SPQRC",
        transcriptText: "Safety, people, quality, responsiveness, delivery, and cost were reviewed for the plant."
      }
    );

    expect(result.meetingType).toBe("weekly_spqrc");
  });

  it("reduces chunk-level classifications into one final meeting type", async () => {
    let call = 0;
    const result = await classifyMeetingAcrossTranscript(
      {
        meetingSubject: "Weekly Sales",
        attendees: [],
        transcriptText: `${"Pipeline forecast customer quotes revenue.\n".repeat(500)}${"General housekeeping.\n".repeat(500)}`
      },
      {
        async generate() {
          call += 1;
          return call === 1
            ? { meetingType: "weekly_sales", confidence: 0.9, signals: ["pipeline", "forecast"], reason: "Sales chunk" }
            : { meetingType: "general", confidence: 0.55, signals: ["housekeeping"], reason: "Generic chunk" };
        }
      }
    );

    expect(call).toBeGreaterThan(1);
    expect(result.meetingType).toBe("weekly_sales");
  });

  it("includes the selected meeting type and strict schema requirements in the summary prompt", () => {
    const prompt = buildSummaryPrompt({
      meetingSubject: "Weekly SPQRC",
      attendees: [],
      transcriptText: "Safety, people, quality, delivery, and cost.",
      meetingType: "weekly_spqrc"
    });

    expect(prompt).toContain("Use the resolved meeting type provided by the classifier.");
    expect(prompt).toContain("Do not reclassify the meeting during recap generation.");
    expect(prompt).toContain("Resolved meeting type: weekly_spqrc");
    expect(prompt).toContain("Meeting type: Weekly SPQRC");
    expect(prompt).toContain("Responsiveness/Delivery:");
  });

  it("rejects extra summary keys and requires action item owner, task, and dueDate", () => {
    expect(() =>
      meetingSummarySchema.parse({
        meetingType: "general",
        summary: ["Meeting type: General"],
        decisions: [],
        actionItems: [{ owner: "Alex", task: "Send the report.", dueDate: "TBD" }],
        openQuestions: [],
        risks: [],
        followUps: [],
        extra: true
      })
    ).toThrow();
    expect(() =>
      meetingSummarySchema.parse({
        meetingType: "general",
        summary: [],
        decisions: [],
        actionItems: [{ task: "Send the report." }],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    ).toThrow();
    expect(
      meetingSummarySchema.parse({
        meetingType: "general",
        summary: [],
        decisions: [],
        actionItems: [{ owner: "Unassigned", task: "Send the report.", dueDate: "TBD" }],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    ).toMatchObject({ actionItems: [{ owner: "Unassigned", dueDate: "TBD" }] });
  });

  it("forces the final meeting type across chunk summaries", async () => {
    let call = 0;
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Weekly Sales",
        attendees: [],
        transcriptText: `${"Pipeline forecast customer quotes revenue.\n".repeat(500)}${"Follow-up quote work.\n".repeat(500)}`
      },
      {
        async generate(prompt) {
          call += 1;
          if (prompt.includes("Classify the Microsoft Teams meeting")) {
            return { meetingType: "weekly_sales", confidence: 0.9, signals: ["pipeline"], reason: "Sales review" };
          }
          return {
            meetingType: "general",
            summary: ["Meeting type: General"],
            decisions: [],
            actionItems: [{ owner: "Unassigned", task: "Prepare quote updates.", dueDate: "TBD" }],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(call).toBeGreaterThan(2);
    expect(summary.meetingType).toBe("weekly_sales");
    expect(summary.summary[0]).toBe("Meeting type: Weekly Sales");
  });
});
