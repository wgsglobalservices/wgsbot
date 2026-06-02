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
            recapDepth: "standard",
            meetingNotes: [
              {
                heading: "Key Discussion Topics:",
                overview: "Launch timing was reviewed.",
                items: [{ title: "Launch Plan:", detail: "Alice said the team decided to launch Friday after reviewing the remaining release tasks." }]
              }
            ],
            followUpTasks: [
              {
                title: "Prepare Launch Notes:",
                description: "Prepare the release notes for the Friday launch.",
                owners: ["Alex"],
                dueDate: "TBD"
              }
            ],
            summary: ["Launch timing was discussed."],
            decisions: ["Launch Friday."],
            actionItems: [{ owner: "Alex", task: "Prepare the release notes for the Friday launch.", dueDate: "TBD" }],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(summary.decisions).toEqual(["Launch Friday."]);
    expect(summary.meetingNotes[0].items[0].title).toBe("Launch Plan:");
    expect(summary.followUpTasks[0].owners).toEqual(["Alex"]);
    expect(summary.meetingType).toBe("general");
    expect(summary.recapDepth).toBe("brief");
  });

  it("classifies duration at or below two minutes as brief while preserving clear actions", async () => {
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Quick sync",
        attendees: [],
        transcriptText: "Alex: We decided Casey will send the report today.",
        meetingDurationMinutes: 2
      },
      {
        async generate(prompt) {
          if (prompt.includes("Classify the Microsoft Teams meeting")) return { meetingType: "general", confidence: 0.7, signals: [], reason: "General" };
          expect(prompt).toContain("Resolved recap depth: brief");
          expect(prompt).toContain("Do not pad short meetings.");
          return {
            meetingType: "general",
            recapDepth: "brief",
            meetingNotes: [{ heading: "Brief meeting recap", overview: "", items: [{ title: "What happened", detail: "A short decision was captured." }] }],
            followUpTasks: [{ title: "Send Report", description: "Send the report today.", owners: ["Casey"], dueDate: "Today" }],
            summary: ["Casey will send the report today."],
            decisions: ["Casey will send the report today."],
            actionItems: [{ owner: "Casey", task: "Send the report today.", dueDate: "Today" }],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(summary.recapDepth).toBe("brief");
    expect(summary.followUpTasks[0].owners).toEqual(["Casey"]);
    expect(summary.decisions).toEqual(["Casey will send the report today."]);
  });

  it("classifies minimal low-substance transcripts as brief and notes transcript limitations", async () => {
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Touch base",
        attendees: [],
        transcriptText: "Alex: Hi, can you hear me?\nCasey: Yes, recording looks on.\nAlex: Okay thanks, bye."
      },
      {
        async generate(prompt) {
          if (prompt.includes("Classify the Microsoft Teams meeting")) return { meetingType: "general", confidence: 0.7, signals: [], reason: "General" };
          return {
            meetingType: "general",
            recapDepth: "brief",
            meetingNotes: [{ heading: "Brief meeting recap", overview: "", items: [{ title: "Outcome", detail: "No substantive meeting content was captured." }] }],
            followUpTasks: [],
            summary: ["No substantive meeting content was captured."],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(summary.recapDepth).toBe("brief");
    expect(summary.openQuestions).toContain("The transcript appears limited, so the recap may not reflect the full meeting.");
  });

  it("uses the universal standard recap prompt without classifying the meeting type", async () => {
    const prompts: string[] = [];
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Weekly operations review",
        attendees: [],
        transcriptText: `${"Alex: The team reviewed safety, quality, delivery, cost, customer issues, staffing, production, and follow-up ownership for next week.\n".repeat(40)}`,
        meetingDurationMinutes: 30
      },
      {
        async generate(prompt) {
          prompts.push(prompt);
          expect(prompt).not.toContain("Classify the Microsoft Teams meeting");
          expect(prompt).toContain("Resolved recap depth: standard");
          expect(prompt).toContain("The recap must work for any meeting type");
          expect(prompt).toContain("Recommended generic detail topics:");
          expect(prompt).not.toContain("Summary template label:");
          expect(prompt).not.toContain("For weekly_spqrc");
          expect(prompt).not.toContain("Safety, People, Quality, Delivery, and Cost Updates");
          return {
            meetingType: "general",
            recapDepth: "standard",
            meetingNotes: [{ heading: "Safety Updates:", overview: "The team reviewed operational updates.", items: [{ title: "Safety:", detail: "Safety and operating priorities were discussed." }] }],
            followUpTasks: [],
            summary: ["Operations were reviewed."],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(prompts).toHaveLength(1);
    expect(summary.recapDepth).toBe("standard");
    expect(summary.meetingType).toBe("general");
  });

  it("builds the WGS layered recap prompt in the requested section order", () => {
    const prompt = buildSummaryPrompt({
      meetingSubject: "Operations sync",
      attendees: [{ name: "Alex", email: "alex@example.com" }],
      transcriptText: "Alex: Casey will confirm the delivery schedule tomorrow.",
      meetingStartTime: "2026-06-01T14:00:00.000Z",
      recapDepth: "standard"
    });

    expect(prompt).toContain("1. Executive Highlights");
    expect(prompt).toContain("2. Person-Specific Briefs");
    expect(prompt).toContain("3. Notes");
    expect(prompt).toContain("4. Action Items");
    expect(prompt).toContain("5. Decisions");
    expect(prompt).toContain("6. Risks / Blockers");
    expect(prompt).toContain("7. Open Questions");
    expect(prompt).toContain("8. Reference Notes");
    expect(prompt).toContain("Action items are grouped by owner.");
    expect(prompt).toContain("Use the resolved meeting type supplied by the classifier when available. Do not reclassify the meeting during recap generation.");
    expect(prompt).toContain("Person-Specific Briefs use meetingNotes entries headed \"Person-Specific Briefs:\"");
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

  it("falls back to general when classification provider output is invalid", async () => {
    const result = await classifyMeetingAcrossTranscript(
      {
        meetingSubject: "Touch base",
        attendees: [],
        transcriptText: "The team reviewed a general status update."
      },
      {
        async generate() {
          return { meetingType: "unknown", confidence: 2, signals: [], reason: "bad payload" };
        }
      }
    );

    expect(result.meetingType).toBe("general");
    expect(result.signals).toContain("classification_failed");
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

  it("includes the universal template and strict schema requirements in the summary prompt", () => {
    const prompt = buildSummaryPrompt({
      meetingSubject: "Weekly SPQRC",
      attendees: [],
      transcriptText: "Safety, people, quality, delivery, and cost.",
      meetingType: "weekly_spqrc"
    });

    expect(prompt).toContain("The recap must work for any meeting type");
    expect(prompt).toContain("WGS / MinutesBot meeting recap");
    expect(prompt).toContain("Generated by AI. Be sure to check for accuracy.");
    expect(prompt).toContain("Required recap structure:");
    expect(prompt).toContain("Recommended generic detail topics:");
    expect(prompt).toContain("Risks / Blockers");
    expect(prompt).not.toContain("Use the resolved meeting type provided by the classifier.");
    expect(prompt).not.toContain("Summary template label:");
    expect(prompt).not.toContain("For weekly_spqrc");
    expect(prompt).not.toContain("Safety, People, Quality, Delivery, and Cost Updates");
  });

  it("builds standard recap prompts around the universal WGS MinutesBot executive recap structure", () => {
    const prompt = buildSummaryPrompt({
      meetingSubject: "Test Sales / Weekly Sales",
      meetingStartTime: "2026-05-19T05:02:00.000Z",
      attendees: [],
      transcriptText: "The team reviewed customer follow-ups, CRM migration, staffing requests, and forecast cleanup.",
      meetingType: "weekly_sales",
      recapDepth: "standard"
    });

    expect(prompt).toContain("WGS / MinutesBot meeting recap");
    expect(prompt).toContain("Clean up unclear speaker labels such as \"Conference Room Computer\"");
    expect(prompt).toContain("1. Executive Highlights:");
    expect(prompt).toContain("This section appears first and must be readable without expanding anything.");
    expect(prompt).toContain("2. Person-Specific Briefs:");
    expect(prompt).toContain("4. Action Items:");
    expect(prompt).toContain("Prioritize:");
    expect(prompt).toContain("Use \"Not defined\" when no mitigation was discussed");
    expect(prompt).toContain("Full Action Register:");
    expect(prompt).toContain("Priority definitions:");
    expect(prompt).toContain("Merge duplicate action items.");
    expect(prompt).toContain("Use the meeting content to select the best topic labels.");
    expect(prompt).not.toContain("For Weekly Sales meetings");
    expect(prompt).not.toContain("For General meetings, use a concise business recap structure");
    expect(prompt).not.toContain("1. Weekly Summary");
    expect(prompt).not.toContain("9. Action Items");
  });

  it("combines chunked recaps into one deduplicated executive recap", async () => {
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Weekly Sales",
        attendees: [],
        transcriptText: `${"Customer blocker revenue staffing risk action ownership.\n".repeat(500)}${"Customer blocker revenue staffing risk action ownership.\n".repeat(500)}`,
        recapDepth: "standard",
        meetingType: "weekly_sales",
        classificationEnabled: false,
        defaultTemplate: "weekly_sales"
      },
      {
        async generate() {
          return {
            meetingType: "weekly_sales",
            recapDepth: "standard",
            executiveRecap: {
              topPriorities: [
                {
                  title: "Customer blocker",
                  summary: "A customer issue is blocking delivery.",
                  whyItMatters: "Customer impact and delivery risk.",
                  owner: "Alex",
                  nextStep: "Call the customer.",
                  dueDate: "2026-06-02"
                }
              ],
              immediateActions: [
                {
                  priority: "High",
                  action: "Call the customer",
                  owner: "Alex",
                  due: "2026-06-02",
                  relatedCustomerOrArea: "Customer A",
                  status: "Open"
                }
              ],
              keyDecisions: [
                {
                  decision: "Escalate the customer blocker today.",
                  impact: "Protects delivery timing.",
                  ownerOrFollowUp: "Alex to call the customer."
                }
              ],
              majorRisks: [
                {
                  title: "Delivery risk",
                  explanation: "The blocker can delay shipment.",
                  impact: "Customer delivery could slip.",
                  mitigationOrNextStep: "Escalate today."
                }
              ],
              detailedRecap: [
                {
                  heading: "Customer Work & Sales Pipeline",
                  summary: "The customer blocker and revenue impact were reviewed."
                }
              ],
              winsAndProgress: [
                {
                  title: "Quote sent",
                  detail: "A quote was sent to Customer A.",
                  impact: "Supports pipeline movement."
                }
              ],
              fullActionRegister: [
                {
                  action: "Call the customer",
                  owner: "Alex",
                  due: "2026-06-02",
                  priority: "High",
                  relatedArea: "Customer A",
                  notes: "Remove the delivery blocker."
                }
              ],
              openQuestions: [
                {
                  question: "Can Customer A approve the change today?",
                  whyItMatters: "Approval unblocks delivery.",
                  ownerOrBestNextStep: "Alex to confirm."
                }
              ],
              referenceNotes: [
                {
                  topic: "Customer A",
                  notes: ["The blocker was raised in both transcript chunks."]
                }
              ]
            },
            meetingNotes: [
              {
                heading: "1. At a Glance:",
                overview: "Customer blocker is the top issue.",
                items: [{ title: "Top Priorities:", detail: "Customer blocker is the top priority." }]
              }
            ],
            followUpTasks: [
              {
                title: "Call Customer:",
                description: "Call the customer about the blocker.",
                owners: ["Alex"],
                dueDate: "2026-06-02"
              }
            ],
            summary: ["Meeting type: Weekly Sales", "Customer blocker is the top priority."],
            decisions: ["Escalate the customer blocker today."],
            actionItems: [{ owner: "Alex", task: "Call the customer about the blocker.", dueDate: "2026-06-02" }],
            openQuestions: ["Can Customer A approve the change today?"],
            risks: ["Delivery risk from the customer blocker."],
            followUps: ["Call the customer about the blocker."]
          };
        }
      }
    );

    expect(summary.meetingType).toBe("weekly_sales");
    expect(summary.executiveRecap.topPriorities).toHaveLength(1);
    expect(summary.executiveRecap.immediateActions).toHaveLength(1);
    expect(summary.executiveRecap.keyDecisions).toHaveLength(1);
    expect(summary.executiveRecap.majorRisks).toHaveLength(1);
    expect(summary.executiveRecap.fullActionRegister).toHaveLength(1);
    expect(summary.executiveRecap.openQuestions).toHaveLength(1);
    expect(summary.meetingNotes).toHaveLength(1);
    expect(summary.followUpTasks).toHaveLength(1);
    expect(summary.decisions).toHaveLength(1);
    expect(summary.actionItems).toHaveLength(1);
    expect(summary.openQuestions).toHaveLength(1);
    expect(summary.risks).toHaveLength(1);
    expect(summary.followUps).toHaveLength(1);
  });

  it("builds brief prompts without the full topic-heavy template", () => {
    const prompt = buildSummaryPrompt({
      meetingSubject: "Weekly SPQRC",
      attendees: [],
      transcriptText: "Alex: Hi, recording worked. Bye.",
      meetingType: "weekly_spqrc",
      recapDepth: "brief"
    });

    expect(prompt).toContain("Resolved recap depth: brief");
    expect(prompt).toContain("Do not pad short meetings.");
    expect(prompt).toContain("meetingNotes must contain exactly 1 heading: Brief meeting recap.");
    expect(prompt).not.toContain("Safety, People, Quality, Delivery, and Cost Updates");
    expect(prompt).not.toContain("Plant Operations Reports");
  });

  it("validates teams-style notes and rejects extra summary keys", () => {
    expect(() =>
      meetingSummarySchema.parse({
        meetingType: "general",
        recapDepth: "standard",
        meetingNotes: [
          {
            heading: "Key Discussion Topics:",
            overview: "The launch was reviewed.",
            items: [{ title: "Launch Timing:", detail: "Alice confirmed the target launch date and described the remaining release work." }]
          }
        ],
        followUpTasks: [{ title: "Release Notes:", description: "Prepare release notes for the launch.", owners: ["Alex"], dueDate: "TBD" }],
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
        recapDepth: "standard",
        meetingNotes: [],
        followUpTasks: [],
        summary: [],
        decisions: [],
        actionItems: [{ task: "Send the report." }],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    ).toThrow();
    expect(() =>
      meetingSummarySchema.parse({
        meetingType: "general",
        meetingNotes: [],
        followUpTasks: [],
        summary: [],
        decisions: [],
        actionItems: [],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    ).toThrow();
    expect(
      meetingSummarySchema.parse({
        meetingType: "general",
        recapDepth: "standard",
        meetingNotes: [
          {
            heading: "Key Discussion Topics:",
            overview: "",
            items: [{ title: "Report:", detail: "The report was discussed." }]
          }
        ],
        followUpTasks: [{ title: "Send Report:", description: "Send the report.", owners: ["Unassigned"], dueDate: "TBD" }],
        summary: [],
        decisions: [],
        actionItems: [{ owner: "Unassigned", task: "Send the report.", dueDate: "TBD" }],
        openQuestions: [],
        risks: [],
        followUps: []
      })
    ).toMatchObject({ followUpTasks: [{ owners: ["Unassigned"], dueDate: "TBD" }], actionItems: [{ owner: "Unassigned", dueDate: "TBD" }] });
  });

  it("forces the universal schema meeting type across chunk summaries without classifier calls", async () => {
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
          expect(prompt).not.toContain("Classify the Microsoft Teams meeting");
          return {
            meetingType: "weekly_sales",
            recapDepth: "standard",
            meetingNotes: [
              {
                heading: "Sales Pipeline and Forecast Updates:",
                overview: "Pipeline movement was reviewed.",
                items: [{ title: "Quote Updates:", detail: "The team reviewed quote follow-up work for active opportunities." }]
              }
            ],
            followUpTasks: [{ title: "Prepare Quote Updates:", description: "Prepare quote updates for active opportunities.", owners: ["Unassigned"], dueDate: "TBD" }],
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

    expect(call).toBeGreaterThan(1);
    expect(summary.meetingType).toBe("general");
    expect(summary.summary[0]).toBe("Meeting type: General");
    expect(summary.meetingNotes[0].heading).toBe("Sales Pipeline and Forecast Updates:");
    expect(summary.followUpTasks[0].title).toBe("Prepare Quote Updates:");
  });

  it("ignores legacy default-template settings and uses the universal recap template", async () => {
    const summary = await summarizeTranscript(
      {
        meetingSubject: "Weekly Sales",
        attendees: [],
        transcriptText: "Pipeline and quotes were discussed.",
        classificationEnabled: false,
        defaultTemplate: "weekly_sales"
      },
      {
        async generate(prompt) {
          expect(prompt).not.toContain("Classify the Microsoft Teams meeting");
          expect(prompt).not.toContain("Resolved meeting type: weekly_sales");
          expect(prompt).toContain("The recap must work for any meeting type");
          return {
            meetingType: "weekly_sales",
            recapDepth: "standard",
            meetingNotes: [
              {
                heading: "Sales Pipeline and Forecast Updates:",
                overview: "Pipeline movement was reviewed.",
                items: [{ title: "Pipeline Movement:", detail: "Pipeline and quotes were discussed for active sales work." }]
              }
            ],
            followUpTasks: [],
            summary: ["Meeting type: General", "Sales forecast/pipeline: Pipeline moved forward."],
            decisions: [],
            actionItems: [],
            openQuestions: [],
            risks: [],
            followUps: []
          };
        }
      }
    );

    expect(summary.meetingType).toBe("general");
    expect(summary.summary[0]).toBe("Meeting type: General");
  });
});
