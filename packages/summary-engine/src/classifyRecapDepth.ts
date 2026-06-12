import type { RecapDepth, SummaryInput } from "./types";

export type RecapDepthClassification = {
  recapDepth: RecapDepth;
  wordCount: number;
  speakerTurnCount: number;
  transcriptDurationMinutes?: number;
  reasons: string[];
  transcriptAppearsLimited: boolean;
};

const shortWordCount = 350;
const shortSpeakerTurns = 8;

const setupTerms = [
  "hello",
  "hi ",
  "can you hear",
  "can everyone hear",
  "recording",
  "waiting",
  "join",
  "joined",
  "leaving",
  "left",
  "setup",
  "test test",
  "thanks everyone",
  "bye"
];

const meaningfulTerms = [
  "decided",
  "decision",
  "approved",
  "agreed",
  "action",
  "follow up",
  "follow-up",
  "owner",
  "due",
  "by friday",
  "next week",
  "customer",
  "plant",
  "quality",
  "safety",
  "delivery",
  "cost",
  "quote",
  "pricing",
  "forecast",
  "issue",
  "risk",
  "blocked",
  "ship",
  "launch"
];

export function classifyRecapDepth(input: SummaryInput): RecapDepthClassification {
  if (input.shortMeetingBriefRecapEnabled === false) {
    return {
      recapDepth: "standard",
      wordCount: input.wordCount ?? countWords(input.transcriptText),
      speakerTurnCount: input.speakerTurnCount ?? countSpeakerTurns(input.transcriptText),
      transcriptDurationMinutes: input.transcriptDurationMinutes,
      reasons: ["short_meeting_detection_disabled"],
      transcriptAppearsLimited: false
    };
  }
  const shortDurationMinutes = input.shortMeetingDurationThresholdMinutes ?? 2;
  const wordCount = input.wordCount ?? countWords(input.transcriptText);
  const speakerTurnCount = input.speakerTurnCount ?? countSpeakerTurns(input.transcriptText);
  const transcriptDurationMinutes = input.transcriptDurationMinutes;
  const reasons: string[] = [];
  const meaningful = hasMeaningfulDiscussion(input.transcriptText);
  const actionOrDecision = hasActionOrDecisionLanguage(input.transcriptText);
  const setupHeavy = isSetupHeavy(input.transcriptText);

  if (transcriptDurationMinutes !== undefined && transcriptDurationMinutes <= shortDurationMinutes) {
    reasons.push("transcript_duration_at_or_below_threshold");
  }

  if (
    input.meetingDurationMinutes !== undefined &&
    input.meetingDurationMinutes <= shortDurationMinutes &&
    !(transcriptDurationMinutes !== undefined && transcriptDurationMinutes > shortDurationMinutes) &&
    !(wordCount >= shortWordCount && meaningful)
  ) {
    reasons.push("meeting_duration_at_or_below_threshold");
  }

  if (input.meetingDurationMinutes === undefined && transcriptDurationMinutes === undefined) {
    if (wordCount < shortWordCount) reasons.push("word_count_below_threshold");
    if (speakerTurnCount < shortSpeakerTurns) reasons.push("speaker_turns_below_threshold");
  }

  if (setupHeavy) reasons.push("mostly_setup_or_small_talk");
  if (!meaningful && !actionOrDecision) reasons.push("no_substantive_discussion");

  const brief = reasons.length > 0 && !(wordCount >= shortWordCount && meaningful && transcriptDurationMinutes === undefined && input.meetingDurationMinutes === undefined);
  return {
    recapDepth: brief ? "brief" : "standard",
    wordCount,
    speakerTurnCount,
    transcriptDurationMinutes,
    reasons,
    transcriptAppearsLimited: brief && (wordCount < 80 || setupHeavy || speakerTurnCount <= 2)
  };
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function countSpeakerTurns(text: string): number {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const speakerLines = lines.filter((line) => /^[^:\n]{1,80}:\s+\S/.test(line));
  if (speakerLines.length > 0) return speakerLines.length;
  return lines.length > 0 ? lines.length : text.trim() ? 1 : 0;
}

export function hasActionOrDecisionLanguage(text: string): boolean {
  return /\b(decided|decision|approved|agreed|will|needs to|need to|follow[- ]?up|action|owner|due|by (friday|monday|tuesday|wednesday|thursday|next week)|assigned)\b/i.test(text);
}

export function hasMeaningfulDiscussion(text: string): boolean {
  const lower = text.toLowerCase();
  return meaningfulTerms.some((term) => lower.includes(term));
}

function isSetupHeavy(text: string): boolean {
  const lower = text.toLowerCase();
  const words = countWords(text);
  if (words === 0) return true;
  const setupHits = setupTerms.filter((term) => lower.includes(term)).length;
  return setupHits >= 2 && !hasMeaningfulDiscussion(text);
}
