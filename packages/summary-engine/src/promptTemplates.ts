import type { SummaryInput } from "./types";

export function buildSummaryPrompt(input: SummaryInput): string {
  return [
    input.prompt ?? [
      "You generate meeting notes from transcripts. Return strict JSON only.",
      "Do not invent facts, owners, due dates, decisions, risks, or follow-ups.",
      "If no decision or action item is present, return an empty array for that field."
    ].join("\n"),
    `Meeting: ${input.meetingSubject}`,
    input.meetingStartTime ? `Start time: ${input.meetingStartTime}` : "",
    input.organizerEmail ? `Organizer: ${input.organizerEmail}` : "",
    `Attendees: ${input.attendees.map((attendee) => attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email).join(", ")}`,
    "JSON shape: {\"summary\": string[], \"decisions\": string[], \"actionItems\": [{\"owner\"?: string, \"task\": string, \"dueDate\"?: string}], \"openQuestions\": string[], \"risks\": string[], \"followUps\": string[]}",
    "Transcript:",
    input.transcriptText
  ]
    .filter(Boolean)
    .join("\n");
}
