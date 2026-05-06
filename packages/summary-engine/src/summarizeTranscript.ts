import { chunkTranscript } from "./chunkTranscript";
import { classifyMeetingAcrossTranscript } from "./classifyMeeting";
import { meetingRecapTypeLabels, type MeetingRecapType } from "./meetingTypes";
import { buildSummaryPrompt } from "./promptTemplates";
import { meetingSummarySchema, type MeetingSummary, type SummaryInput, type SummaryProvider } from "./types";

export async function summarizeTranscript(input: SummaryInput, provider: SummaryProvider): Promise<MeetingSummary> {
  const chunks = chunkTranscript(input.transcriptText);
  const classification = await classifyMeetingAcrossTranscript(input, provider);
  const meetingType = classification.meetingType;
  const partials: MeetingSummary[] = [];
  for (const chunk of chunks) {
    const result = await provider.generate(buildSummaryPrompt({ ...input, transcriptText: chunk, meetingType }));
    partials.push({ ...meetingSummarySchema.parse(result), meetingType });
  }
  return combineSummaries(partials, meetingType);
}

function combineSummaries(summaries: MeetingSummary[], meetingType: MeetingRecapType): MeetingSummary {
  return {
    meetingType,
    summary: normalizeSummaryLines(meetingType, summaries.flatMap((summary) => summary.summary)),
    decisions: summaries.flatMap((summary) => summary.decisions),
    actionItems: summaries.flatMap((summary) => summary.actionItems),
    openQuestions: summaries.flatMap((summary) => summary.openQuestions),
    risks: summaries.flatMap((summary) => summary.risks),
    followUps: summaries.flatMap((summary) => summary.followUps)
  };
}

function normalizeSummaryLines(meetingType: MeetingRecapType, lines: string[]): string[] {
  const expected = `Meeting type: ${meetingRecapTypeLabels[meetingType]}`;
  const withoutTypeLines = lines.filter((line) => !line.toLowerCase().startsWith("meeting type:"));
  return [expected, ...withoutTypeLines];
}
