import { z } from "zod";
import { meetingRecapTypeSchema, type MeetingRecapType } from "./meetingTypes";

export const recapDepths = ["brief", "standard"] as const;
export type RecapDepth = (typeof recapDepths)[number];
export const recapDepthSchema = z.enum(recapDepths);

export type SummaryInput = {
  meetingSubject: string;
  meetingStartTime?: string;
  meetingEndTime?: string;
  meetingDurationMinutes?: number;
  transcriptDurationMinutes?: number;
  speakerTurnCount?: number;
  wordCount?: number;
  shortMeetingBriefRecapEnabled?: boolean;
  shortMeetingDurationThresholdMinutes?: number;
  organizerEmail?: string;
  attendees: Array<{ name?: string; email: string }>;
  transcriptText: string;
  prompt?: string;
  meetingType?: MeetingRecapType;
  recapDepth?: RecapDepth;
  classificationEnabled?: boolean;
  defaultTemplate?: MeetingRecapType | "auto";
};

const executiveRecapDefaults = {
  topPriorities: [],
  immediateActions: [],
  keyDecisions: [],
  majorRisks: [],
  detailedRecap: [],
  winsAndProgress: [],
  fullActionRegister: [],
  openQuestions: [],
  referenceNotes: []
};

const executiveRecapSchema = z
  .object({
    topPriorities: z.array(
      z
        .object({
          title: z.string(),
          summary: z.string(),
          whyItMatters: z.string(),
          owner: z.string(),
          nextStep: z.string(),
          dueDate: z.string()
        })
        .strict()
    ),
    immediateActions: z.array(
      z
        .object({
          priority: z.string(),
          action: z.string(),
          owner: z.string(),
          due: z.string(),
          relatedCustomerOrArea: z.string(),
          status: z.string()
        })
        .strict()
    ),
    keyDecisions: z.array(
      z
        .object({
          decision: z.string(),
          impact: z.string(),
          ownerOrFollowUp: z.string()
        })
        .strict()
    ),
    majorRisks: z.array(
      z
        .object({
          title: z.string(),
          explanation: z.string(),
          impact: z.string(),
          mitigationOrNextStep: z.string()
        })
        .strict()
    ),
    detailedRecap: z.array(
      z
        .object({
          heading: z.string(),
          summary: z.string()
        })
        .strict()
    ),
    winsAndProgress: z.array(
      z
        .object({
          title: z.string(),
          detail: z.string(),
          impact: z.string()
        })
        .strict()
    ),
    fullActionRegister: z.array(
      z
        .object({
          action: z.string(),
          owner: z.string(),
          due: z.string(),
          priority: z.enum(["High", "Medium", "Low"]),
          relatedArea: z.string(),
          notes: z.string()
        })
        .strict()
    ),
    openQuestions: z.array(
      z
        .object({
          question: z.string(),
          whyItMatters: z.string(),
          ownerOrBestNextStep: z.string()
        })
        .strict()
    ),
    referenceNotes: z.array(
      z
        .object({
          topic: z.string(),
          notes: z.array(z.string())
        })
        .strict()
    )
  })
  .strict()
  .optional()
  .default(executiveRecapDefaults);

export const meetingSummarySchema = z
  .object({
    meetingType: meetingRecapTypeSchema,
    recapDepth: recapDepthSchema,
    executiveRecap: executiveRecapSchema,
    meetingNotes: z.array(
      z
        .object({
          heading: z.string(),
          overview: z.string(),
          items: z.array(
            z
              .object({
                title: z.string(),
                detail: z.string()
              })
              .strict()
          )
        })
        .strict()
    ),
    followUpTasks: z.array(
      z
        .object({
          title: z.string(),
          description: z.string(),
          owners: z.array(z.string()),
          dueDate: z.string()
        })
        .strict()
    ),
    summary: z.array(z.string()),
    decisions: z.array(z.string()),
    actionItems: z.array(
      z
        .object({
          owner: z.string(),
          task: z.string(),
          dueDate: z.string()
        })
        .strict()
    ),
    openQuestions: z.array(z.string()),
    risks: z.array(z.string()),
    followUps: z.array(z.string())
  })
  .strict();

export type MeetingSummary = z.infer<typeof meetingSummarySchema>;

export type SummaryProvider = {
  generate(prompt: string): Promise<unknown>;
};

export type TranscriptionResult = {
  text: string;
  usage?: Record<string, unknown>;
};

export type TranscriptionProvider = {
  transcribe(audio: ArrayBuffer, contentType: string): Promise<TranscriptionResult>;
};
