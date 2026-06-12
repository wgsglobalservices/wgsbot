import { chunkTranscript } from "./chunkTranscript";
import { classifyRecapDepth } from "./classifyRecapDepth";
import { classifyMeetingAcrossTranscript } from "./classifyMeeting";
import { meetingRecapTypeLabels, type MeetingRecapType } from "./meetingTypes";
import { buildSummaryPrompt } from "./promptTemplates";
import { meetingSummarySchema, type MeetingSummary, type RecapDepth, type SummaryInput, type SummaryProvider } from "./types";

export async function summarizeTranscript(input: SummaryInput, provider: SummaryProvider): Promise<MeetingSummary> {
  const depthClassification = classifyRecapDepth(input);
  const enrichedInput = {
    ...input,
    recapDepth: input.recapDepth ?? depthClassification.recapDepth,
    wordCount: input.wordCount ?? depthClassification.wordCount,
    speakerTurnCount: input.speakerTurnCount ?? depthClassification.speakerTurnCount,
    transcriptDurationMinutes: input.transcriptDurationMinutes ?? depthClassification.transcriptDurationMinutes
  };
  const meetingType = await resolveSummaryMeetingType(input, provider);
  // A "brief" recap can be triggered by a short *meeting duration* while the
  // transcript itself is arbitrarily long; cap the single chunk so the
  // prompt cannot balloon.
  const chunks = enrichedInput.recapDepth === "brief" ? chunkTranscript(input.transcriptText).slice(0, 1) : chunkTranscript(input.transcriptText);
  const partials: MeetingSummary[] = [];
  for (const chunk of chunks) {
    const result = await provider.generate(buildSummaryPrompt({ ...enrichedInput, transcriptText: chunk, meetingType }));
    const parsed = meetingSummarySchema.parse(result);
    partials.push({
      ...parsed,
      meetingType,
      recapDepth: enrichedInput.recapDepth,
      openQuestions: withTranscriptLimitation(parsed.openQuestions, depthClassification.transcriptAppearsLimited)
    });
  }
  return combineSummaries(partials, meetingType, enrichedInput.recapDepth);
}

async function resolveSummaryMeetingType(input: SummaryInput, provider: SummaryProvider): Promise<MeetingRecapType> {
  if (input.classificationEnabled === false) {
    return input.defaultTemplate && input.defaultTemplate !== "auto" ? input.defaultTemplate : "general";
  }
  const classification = await classifyMeetingAcrossTranscript(input, provider);
  return classification.meetingType;
}

function combineSummaries(summaries: MeetingSummary[], meetingType: MeetingRecapType, recapDepth: RecapDepth): MeetingSummary {
  return {
    meetingType,
    recapDepth,
    meetingNotes: summaries.flatMap((summary) => summary.meetingNotes),
    followUpTasks: summaries.flatMap((summary) => summary.followUpTasks),
    summary: normalizeSummaryLines(meetingType, recapDepth, summaries.flatMap((summary) => summary.summary)),
    // Chunk boundaries repeat items the model saw in both chunks; dedupe the
    // simple string sections so recaps do not list them twice.
    decisions: dedupeLines(summaries.flatMap((summary) => summary.decisions)),
    actionItems: summaries.flatMap((summary) => summary.actionItems),
    openQuestions: dedupeLines(summaries.flatMap((summary) => summary.openQuestions)),
    risks: dedupeLines(summaries.flatMap((summary) => summary.risks)),
    followUps: dedupeLines(summaries.flatMap((summary) => summary.followUps))
  };
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSummaryLines(meetingType: MeetingRecapType, recapDepth: RecapDepth, lines: string[]): string[] {
  const expectedType = `Meeting type: ${meetingRecapTypeLabels[meetingType]}`;
  const expectedDepth = `Recap depth: ${recapDepth === "brief" ? "Brief" : "Standard"}`;
  const normalized = lines.filter((line) => {
    const lower = line.toLowerCase();
    return !lower.startsWith("meeting type:") && !lower.startsWith("recap depth:");
  });
  return [expectedType, expectedDepth, ...normalized].slice(0, recapDepth === "brief" ? 5 : undefined);
}

function withTranscriptLimitation(openQuestions: string[], limited: boolean): string[] {
  if (!limited) return openQuestions;
  const limitation = "The transcript appears limited, so the recap may not reflect the full meeting.";
  return openQuestions.some((item) => item.toLowerCase().includes("transcript appears limited")) ? openQuestions : [...openQuestions, limitation];
}
