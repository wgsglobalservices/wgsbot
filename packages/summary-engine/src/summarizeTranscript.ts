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
  const chunks = enrichedInput.recapDepth === "brief" ? [input.transcriptText] : chunkTranscript(input.transcriptText);
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
    executiveRecap: combineExecutiveRecaps(summaries),
    meetingNotes: mergeMeetingNotes(summaries.flatMap((summary) => summary.meetingNotes)),
    followUpTasks: uniqueBy(summaries.flatMap((summary) => summary.followUpTasks), (task) => `${task.title}|${task.description}|${task.owners.join(",")}|${task.dueDate}`),
    summary: normalizeSummaryLines(meetingType, recapDepth, summaries.flatMap((summary) => summary.summary)),
    decisions: uniqueStrings(summaries.flatMap((summary) => summary.decisions)),
    actionItems: uniqueBy(summaries.flatMap((summary) => summary.actionItems), (item) => `${item.owner}|${item.task}|${item.dueDate}`),
    openQuestions: uniqueStrings(summaries.flatMap((summary) => summary.openQuestions)),
    risks: uniqueStrings(summaries.flatMap((summary) => summary.risks)),
    followUps: uniqueStrings(summaries.flatMap((summary) => summary.followUps))
  };
}

function normalizeSummaryLines(meetingType: MeetingRecapType, recapDepth: RecapDepth, lines: string[]): string[] {
  const expectedType = `Meeting type: ${meetingRecapTypeLabels[meetingType]}`;
  const expectedDepth = `Recap depth: ${recapDepth === "brief" ? "Brief" : "Standard"}`;
  const normalized = uniqueStrings(lines).filter((line) => {
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

function combineExecutiveRecaps(summaries: MeetingSummary[]): MeetingSummary["executiveRecap"] {
  const recaps = summaries.map((summary) => summary.executiveRecap);
  return {
    topPriorities: uniqueBy(recaps.flatMap((recap) => recap.topPriorities), (item) => `${item.title}|${item.summary}`).slice(0, 7),
    immediateActions: uniqueBy(recaps.flatMap((recap) => recap.immediateActions), (item) => `${item.action}|${item.owner}|${item.due}`).slice(0, 10),
    keyDecisions: uniqueBy(recaps.flatMap((recap) => recap.keyDecisions), (item) => `${item.decision}|${item.impact}`),
    majorRisks: uniqueBy(recaps.flatMap((recap) => recap.majorRisks), (item) => `${item.title}|${item.explanation}`).slice(0, 7),
    detailedRecap: mergeDetailedRecap(recaps.flatMap((recap) => recap.detailedRecap)),
    winsAndProgress: uniqueBy(recaps.flatMap((recap) => recap.winsAndProgress), (item) => `${item.title}|${item.detail}`),
    fullActionRegister: uniqueBy(recaps.flatMap((recap) => recap.fullActionRegister), (item) => `${item.action}|${item.owner}|${item.due}|${item.relatedArea}`),
    openQuestions: uniqueBy(recaps.flatMap((recap) => recap.openQuestions), (item) => `${item.question}|${item.ownerOrBestNextStep}`).slice(0, 12),
    referenceNotes: mergeReferenceNotes(recaps.flatMap((recap) => recap.referenceNotes))
  };
}

function mergeMeetingNotes(notes: MeetingSummary["meetingNotes"]): MeetingSummary["meetingNotes"] {
  const merged = new Map<string, MeetingSummary["meetingNotes"][number]>();
  for (const note of notes) {
    const key = normalizeKey(note.heading);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...note,
        items: uniqueBy(note.items, (item) => `${item.title}|${item.detail}`)
      });
      continue;
    }
    const overviews = uniqueStrings([existing.overview, note.overview].filter(Boolean));
    existing.overview = overviews.join(" ");
    existing.items = uniqueBy([...existing.items, ...note.items], (item) => `${item.title}|${item.detail}`);
  }
  return Array.from(merged.values());
}

function mergeDetailedRecap(items: MeetingSummary["executiveRecap"]["detailedRecap"]): MeetingSummary["executiveRecap"]["detailedRecap"] {
  const merged = new Map<string, MeetingSummary["executiveRecap"]["detailedRecap"][number]>();
  for (const item of items) {
    const key = normalizeKey(item.heading);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, item);
      continue;
    }
    existing.summary = uniqueStrings([existing.summary, item.summary]).join(" ");
  }
  return Array.from(merged.values());
}

function mergeReferenceNotes(items: MeetingSummary["executiveRecap"]["referenceNotes"]): MeetingSummary["executiveRecap"]["referenceNotes"] {
  const merged = new Map<string, MeetingSummary["executiveRecap"]["referenceNotes"][number]>();
  for (const item of items) {
    const key = normalizeKey(item.topic);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...item, notes: uniqueStrings(item.notes) });
      continue;
    }
    existing.notes = uniqueStrings([...existing.notes, ...item.notes]);
  }
  return Array.from(merged.values());
}

function uniqueStrings(items: string[]): string[] {
  return uniqueBy(items, (item) => item);
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = normalizeKey(getKey(item));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.:;,\s]+$/g, "");
}
