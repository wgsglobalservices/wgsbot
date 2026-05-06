import { z } from "zod";
import { meetingRecapTypeSchema, type MeetingRecapType } from "./meetingTypes";

export type SummaryInput = {
  meetingSubject: string;
  meetingStartTime?: string;
  organizerEmail?: string;
  attendees: Array<{ name?: string; email: string }>;
  transcriptText: string;
  prompt?: string;
  meetingType?: MeetingRecapType;
};

export const meetingSummarySchema = z
  .object({
    meetingType: meetingRecapTypeSchema,
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
