import { meetingRecapTypeLabels, type MeetingRecapType } from "./meetingTypes";
import type { SummaryInput } from "./types";

export function buildSummaryPrompt(input: SummaryInput): string {
  const meetingType = input.meetingType ?? "general";
  return [
    buildBaseInstructions(input.prompt),
    `Meeting: ${input.meetingSubject}`,
    input.meetingStartTime ? `Start time: ${input.meetingStartTime}` : "",
    input.organizerEmail ? `Organizer: ${input.organizerEmail}` : "",
    `Attendees: ${input.attendees.map((attendee) => attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email).join(", ")}`,
    `Resolved meeting type: ${meetingType}`,
    buildMeetingTypeSummaryInstructions(meetingType),
    "JSON shape: {\"meetingType\":\"weekly_spqrc\"|\"weekly_sales\"|\"plant_meeting\"|\"general\",\"summary\":string[],\"decisions\":string[],\"actionItems\":[{\"owner\":\"string\",\"task\":\"string\",\"dueDate\":\"string\"}],\"openQuestions\":string[],\"risks\":string[],\"followUps\":string[]}",
    "Transcript:",
    input.transcriptText
  ]
    .filter(Boolean)
    .join("\n");
}

function buildBaseInstructions(customPrompt?: string): string {
  return [
    customPrompt,
    "You generate WGS meeting recaps from Microsoft Teams meeting titles and transcripts.",
    "Return strict JSON only.",
    "Do not return markdown, code fences, prose, comments, or extra keys.",
    "Do not invent facts, owners, deadlines, decisions, risks, metrics, customer names, plant names, or follow-ups.",
    "If something is unclear, say \"Unclear\".",
    "If something is not mentioned, say \"Not specified\".",
    "If there are no items for a field, return an empty array.",
    "Use the resolved meeting type provided by the classifier.",
    "Do not reclassify the meeting during recap generation.",
    "Be concise and action-oriented.",
    "Prioritize what changed, what was decided, who owns what, and what must happen next.",
    "Avoid verbatim quotes unless the exact wording is critical.",
    "Use plain business language suitable for an email recap.",
    "Action items must be concrete and execution-focused. Each action item must include owner, task, and dueDate. Use owner \"Unassigned\" and dueDate \"TBD\" when not specified.",
    "Only include confirmed decisions. Capture risks, open questions, and follow-ups separately."
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildMeetingTypeSummaryInstructions(meetingType: MeetingRecapType): string {
  const instructions: Record<MeetingRecapType, string[]> = {
    weekly_spqrc: [
      "For weekly_spqrc, the summary array must follow this exact structure:",
      "\"Meeting type: Weekly SPQRC\"",
      "\"Safety: [key safety topics, incidents, risks, corrective actions, or Not specified]\"",
      "\"People: [labor, staffing, attendance, training, morale, HR, or Not specified]\"",
      "\"Quality: [defects, customer complaints, scrap, rework, audits, corrective actions, or Not specified]\"",
      "\"Responsiveness/Delivery: [schedule, on-time delivery, customer response, backlog, bottlenecks, or Not specified]\"",
      "\"Cost: [cost issues, overtime, material cost, waste, efficiency, margin impact, or Not specified]\"",
      "\"Top priorities before next meeting: [1-3 concrete priorities]\""
    ],
    weekly_sales: [
      "For weekly_sales, the summary array must follow this exact structure:",
      "\"Meeting type: Weekly Sales\"",
      "\"Sales forecast/pipeline: [forecast, pipeline movement, opportunities, or Not specified]\"",
      "\"Customer/account updates: [important customer movement, meetings, risks, requests, or Not specified]\"",
      "\"Quotes/pricing: [quotes, pricing, margin, commercial terms, or Not specified]\"",
      "\"Wins/losses: [new wins, lost deals, stalled deals, or Not specified]\"",
      "\"Risks to revenue: [customer, timing, pricing, supply, quality, or internal blockers]\"",
      "\"Top priorities before next meeting: [1-3 concrete sales priorities]\""
    ],
    plant_meeting: [
      "For plant_meeting, the summary array must follow this exact structure:",
      "\"Meeting type: Individual Plant Meeting\"",
      "\"Plant/site: [specific plant, site, or facility name if mentioned; otherwise Not specified]\"",
      "\"Operating status: [overall plant status, production performance, or Not specified]\"",
      "\"Safety/people: [safety, staffing, training, attendance, labor, or Not specified]\"",
      "\"Production/schedule: [throughput, schedule, backlog, customer shipments, or Not specified]\"",
      "\"Quality/customer issues: [quality concerns, complaints, audits, customer impact, or Not specified]\"",
      "\"Maintenance/materials: [equipment, downtime, tooling, materials, inventory, or Not specified]\"",
      "\"Top priorities before next meeting: [1-3 concrete plant priorities]\""
    ],
    general: [
      "For general, the summary array must follow this exact structure:",
      "\"Meeting type: General\"",
      "\"Purpose: [main reason for the meeting]\"",
      "\"Key discussion: [most important topics discussed]\"",
      "\"Current status: [project, issue, initiative, or business status]\"",
      "\"Key outcomes: [results, agreements, or progress]\"",
      "\"Top priorities before next meeting: [1-3 concrete priorities]\""
    ]
  };
  return [`Summary template label: ${meetingRecapTypeLabels[meetingType]}`, ...instructions[meetingType]].join("\n");
}
