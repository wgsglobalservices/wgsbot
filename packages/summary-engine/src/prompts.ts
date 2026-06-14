import type { RecapMeetingContext } from "./generateRecap";

export const recapSystemPrompt = [
  "You generate meeting recaps as strict JSON. Respond with a single JSON object and nothing else.",
  "The object must contain exactly these fields:",
  '- "overview": string. A concise overview of the meeting.',
  '- "decisions": array of strings. Confirmed decisions only. May be empty.',
  '- "actionItems": array of objects. Each object has "task" (string, required), "owner" (string, optional), "dueDate" (string, optional; use the verbatim wording or an ISO date when one was stated), and "timestampSeconds" (non-negative number, optional). May be empty.',
  '- "risks": array of strings. May be empty.',
  '- "openQuestions": array of strings. May be empty.',
  '- "importantDates": array of objects, each with "date" (string) and "description" (string). May be empty.',
  '- "followUps": array of strings. May be empty.',
  "Rules:",
  "- NEVER invent facts, owners, due dates, decisions, or risks. Only report what the transcript supports.",
  "- Omit optional fields entirely rather than guessing. Omit \"owner\" when no owner is stated and \"dueDate\" when no due date is stated.",
  "- Include \"timestampSeconds\" only when the transcript carries usable timing information for that action item.",
  "- If the transcript lacks information for a field, return an empty array for that field.",
  '- If the transcript lacks enough content for an overview, use a short statement such as "Not enough information was discussed to summarize this meeting."',
  "- Output JSON only. Do not wrap the response in markdown code fences. Do not add commentary or extra keys."
].join("\n");

export function buildRecapUserPrompt(meeting: RecapMeetingContext, transcriptText: string): string {
  return [
    "Generate the meeting recap JSON for the following meeting.",
    meeting.subject ? `Subject: ${meeting.subject}` : "",
    meeting.startTime ? `Start time: ${meeting.startTime}` : "",
    meeting.durationMinutes !== undefined ? `Duration minutes: ${meeting.durationMinutes}` : "",
    meeting.attendeeNames && meeting.attendeeNames.length > 0 ? `Attendees: ${meeting.attendeeNames.join(", ")}` : "",
    "Transcript:",
    transcriptText
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildRepairPrompt(invalidOutput: string, issues: string): string {
  return [
    "Your previous response was not valid recap JSON.",
    "Validation issues:",
    issues,
    "Previous response (possibly truncated):",
    invalidOutput.slice(0, 4000),
    "Respond with the corrected JSON object only, matching the required schema exactly. No markdown fences, no commentary."
  ].join("\n");
}

export const condenseSystemPrompt = [
  "You condense a segment of a meeting transcript into plain-text notes for a later summarization pass.",
  "Capture decisions, action items (with owners, due dates, and timing only when stated), risks, open questions, important dates, and follow-ups.",
  "NEVER invent facts, owners, due dates, decisions, or risks. If the segment contains nothing substantive, say so briefly.",
  "Respond with plain text only."
].join("\n");

export function buildCondensePrompt(chunkIndex: number, chunkCount: number, chunkText: string): string {
  return [
    `Transcript segment ${chunkIndex + 1} of ${chunkCount}:`,
    chunkText,
    "Condense this segment into concise plain-text notes."
  ].join("\n");
}
