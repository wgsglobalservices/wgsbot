import { z } from "zod";
import { chunkTranscript } from "./chunkTranscript";
import { meetingRecapTypeSchema, type MeetingRecapType } from "./meetingTypes";
import type { SummaryInput, SummaryProvider } from "./types";

export const meetingClassificationSchema = z
  .object({
    meetingType: meetingRecapTypeSchema,
    confidence: z.number().min(0).max(1),
    signals: z.array(z.string()),
    reason: z.string()
  })
  .strict();

export type MeetingClassification = z.infer<typeof meetingClassificationSchema>;

export function buildMeetingClassificationPrompt(input: SummaryInput): string {
  return [
    "Classify the Microsoft Teams meeting using the meeting title, metadata, and transcript chunk.",
    "Review the transcript content provided for this chunk and return the best structured classification result.",
    "Return strict JSON only. Do not return markdown, code fences, prose, comments, or extra keys.",
    "Use only these meetingType values: weekly_spqrc, weekly_sales, plant_meeting, general.",
    "weekly_spqrc: recurring SPQRC/SQPRC/operations/KPI/scorecard reviews focused on Safety, People, Quality, Responsiveness or Delivery, and Cost.",
    "Strong weekly_spqrc title signals: SPQRC, SQPRC, weekly operations, weekly KPI, scorecard, safety quality delivery cost, operations review.",
    "weekly_spqrc transcript signals: safety incidents, staffing or people updates, quality defects, scrap or rework, customer complaints, delivery performance, responsiveness, backlog, on-time delivery, cost performance, overtime, corrective actions, plant KPI review, operating metrics, escalations.",
    "weekly_sales: recurring sales, commercial, pipeline, forecast, CRM, quote, customer, account, business development, or revenue reviews.",
    "Strong weekly_sales title signals: weekly sales, sales meeting, pipeline, forecast, CRM, quotes, customer review, account review, business development, commercial review.",
    "weekly_sales transcript signals: opportunities, prospects, quotes, pricing, margin, customers, accounts, revenue, forecast, wins, losses, customer follow-ups, sales activity, deal stage, CRM updates.",
    "plant_meeting: one specific plant, site, facility, operating location, production meeting, operations meeting, facility review, or a named plant/site/facility.",
    "plant_meeting transcript signals: local staffing, production schedule, shipments, equipment downtime, maintenance, safety, quality, materials, inventory, customer orders, plant-specific action items, plant-specific production issues.",
    "general: meetings that do not clearly fit the other types or have low confidence.",
    "Tie-breaking: SPQRC structure beats plant-specific context. Sales/customer/pipeline purpose beats plant/service issues. Use general for low confidence.",
    "JSON shape: {\"meetingType\":\"weekly_spqrc\"|\"weekly_sales\"|\"plant_meeting\"|\"general\",\"confidence\":0.0,\"signals\":[\"string\"],\"reason\":\"string\"}",
    `Meeting subject: ${input.meetingSubject}`,
    input.meetingStartTime ? `Start time: ${input.meetingStartTime}` : "",
    input.organizerEmail ? `Organizer: ${input.organizerEmail}` : "",
    `Attendees: ${input.attendees.map((attendee) => (attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email)).join(", ")}`,
    "Transcript chunk:",
    input.transcriptText
  ]
    .filter(Boolean)
    .join("\n");
}

export async function classifyMeetingAcrossTranscript(input: SummaryInput, provider: SummaryProvider): Promise<MeetingClassification> {
  const chunks = chunkTranscript(input.transcriptText);
  const classifications: MeetingClassification[] = [];
  for (const chunk of chunks) {
    try {
      const result = await provider.generate(buildMeetingClassificationPrompt({ ...input, transcriptText: chunk }));
      classifications.push(meetingClassificationSchema.parse(result));
    } catch {
      classifications.push({ meetingType: "general", confidence: 0, signals: ["classification_failed"], reason: "Classification failed" });
    }
  }
  return resolveMeetingType(classifications, input);
}

export function resolveMeetingType(votes: MeetingClassification[], input: Pick<SummaryInput, "meetingSubject" | "transcriptText">): MeetingClassification {
  const titleSignals = detectSignals(input.meetingSubject);
  const transcriptSignals = detectSignals(input.transcriptText);
  const allSignals = new Set([...titleSignals.signals, ...transcriptSignals.signals, ...votes.flatMap((vote) => vote.signals)]);
  const scores: Record<MeetingRecapType, number> = {
    weekly_spqrc: scoreFor("weekly_spqrc", votes, titleSignals, transcriptSignals),
    weekly_sales: scoreFor("weekly_sales", votes, titleSignals, transcriptSignals),
    plant_meeting: scoreFor("plant_meeting", votes, titleSignals, transcriptSignals),
    general: scoreFor("general", votes, titleSignals, transcriptSignals)
  };

  if (titleSignals.strong.weekly_spqrc || transcriptSignals.strong.weekly_spqrc) scores.weekly_spqrc += 1.4;
  if (titleSignals.strong.weekly_sales || transcriptSignals.strong.weekly_sales) scores.weekly_sales += 1.2;
  if (titleSignals.strong.plant_meeting || transcriptSignals.strong.plant_meeting) scores.plant_meeting += 0.9;

  if (hasSpqrcStructure(input) && scores.weekly_spqrc >= 1.2) scores.weekly_spqrc += 2;
  if (hasSalesPurpose(input) && scores.weekly_sales >= 1) scores.weekly_sales += 1.5;
  if (hasPlantFocus(input) && scores.plant_meeting >= 1) scores.plant_meeting += 1;

  const nonGeneral: MeetingRecapType[] = ["weekly_spqrc", "weekly_sales", "plant_meeting"];
  nonGeneral.sort((a, b) => scores[b] - scores[a]);
  const best = nonGeneral[0];
  const bestConfidence = Math.max(...votes.filter((vote) => vote.meetingType === best).map((vote) => vote.confidence), 0);
  const hasStrongSignal = titleSignals.strong[best] || transcriptSignals.strong[best];
  const meetingType: MeetingRecapType = scores[best] >= 1.5 && (bestConfidence >= 0.45 || hasStrongSignal) ? best : "general";

  return {
    meetingType,
    confidence: meetingType === "general" ? Math.max(scores.general, 0.5) : Math.min(1, Math.max(bestConfidence, scores[meetingType] / 5)),
    signals: Array.from(allSignals).slice(0, 12),
    reason: `Resolved from ${votes.length} chunk classification${votes.length === 1 ? "" : "s"}, confidence, title signals, and precedence rules.`
  };
}

function scoreFor(type: MeetingRecapType, votes: MeetingClassification[], titleSignals: SignalDetection, transcriptSignals: SignalDetection): number {
  return (
    votes.filter((vote) => vote.meetingType === type).reduce((sum, vote) => sum + vote.confidence, 0) +
    (titleSignals.strong[type] ? 1.5 : titleSignals.weak[type] ? 0.6 : 0) +
    (transcriptSignals.strong[type] ? 1 : transcriptSignals.weak[type] ? 0.4 : 0)
  );
}

type SignalDetection = {
  strong: Record<MeetingRecapType, boolean>;
  weak: Record<MeetingRecapType, boolean>;
  signals: string[];
};

function detectSignals(text: string): SignalDetection {
  const lower = text.toLowerCase();
  const contains = (terms: string[]) => terms.some((term) => lower.includes(term));
  const strong = {
    weekly_spqrc: contains(["spqrc", "sqprc", "weekly operations", "weekly kpi", "scorecard", "safety quality delivery cost", "operations review"]),
    weekly_sales: contains(["weekly sales", "sales meeting", "pipeline", "forecast", "crm", "quotes", "customer review", "account review", "business development", "commercial review"]),
    plant_meeting: contains(["plant meeting", "site meeting", "facility meeting", "production meeting", "operations meeting", "facility review", "plant review", "site review"]),
    general: false
  };
  const weak = {
    weekly_spqrc: contains([
      "safety incidents",
      "staffing",
      "quality defects",
      "scrap",
      "rework",
      "customer complaints",
      "delivery performance",
      "responsiveness",
      "backlog",
      "on-time delivery",
      "cost performance",
      "overtime",
      "corrective actions",
      "plant kpi",
      "plant kpi review",
      "operating metrics",
      "escalations"
    ]),
    weekly_sales: contains(["opportunities", "prospects", "quotes", "pricing", "margin", "customers", "accounts", "revenue", "forecast", "wins", "losses", "customer follow-ups", "sales activity", "deal stage", "crm updates"]),
    plant_meeting: contains(["local staffing", "production schedule", "shipments", "equipment downtime", "maintenance", "safety", "quality", "materials", "inventory", "customer orders", "plant-specific", "production issues"]),
    general: false
  };
  const signals = Object.entries({ ...strong, ...weak })
    .filter(([, present]) => present)
    .map(([key]) => key);
  return { strong, weak, signals };
}

function hasSpqrcStructure(input: Pick<SummaryInput, "meetingSubject" | "transcriptText">): boolean {
  const text = `${input.meetingSubject}\n${input.transcriptText}`.toLowerCase();
  return /s[qp]prc|spqrc/.test(text) || ["safety", "people", "quality", "delivery", "cost"].filter((term) => text.includes(term)).length >= 4;
}

function hasSalesPurpose(input: Pick<SummaryInput, "meetingSubject" | "transcriptText">): boolean {
  const text = `${input.meetingSubject}\n${input.transcriptText}`.toLowerCase();
  return ["pipeline", "forecast", "quote", "pricing", "revenue", "crm", "opportunit", "customer"].filter((term) => text.includes(term)).length >= 3;
}

function hasPlantFocus(input: Pick<SummaryInput, "meetingSubject" | "transcriptText">): boolean {
  const text = `${input.meetingSubject}\n${input.transcriptText}`.toLowerCase();
  return /\b(plant|site|facility)\b/.test(text) || ["production schedule", "shipments", "downtime", "maintenance", "materials", "inventory"].filter((term) => text.includes(term)).length >= 3;
}
