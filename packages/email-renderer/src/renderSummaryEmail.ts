import { meetingRecapTypeLabels } from "@minutesbot/summary-engine";
import type { RenderedEmail, SummaryEmailInput } from "./types";

export function renderSummaryEmail(input: SummaryEmailInput): RenderedEmail {
  const sections = resolveSections(input);
  const meetingTypeLabel = meetingRecapTypeLabels[input.summary.meetingType ?? "general"];
  const text = [
    "Meeting",
    input.subject,
    input.date ?? "",
    input.recap?.introText ?? "",
    `Meeting type\n${meetingTypeLabel}\n`,
    "",
    ...sections.map((section) => sectionText(section.label, section.items)),
    sectionText("Not sent to external attendees", input.excludedRecipients ?? [])
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<main>${heading("Meeting")}${paragraph(input.subject)}${input.date ? paragraph(input.date) : ""}${input.recap?.introText ? paragraph(input.recap.introText) : ""}${heading("Meeting type")}${paragraph(meetingTypeLabel)}${sections.map((section) => sectionHtml(section.label, section.items)).join("")}${sectionHtml("Not sent to external attendees", input.excludedRecipients ?? [])}</main>`;
  return { subject: `${input.recap?.subjectPrefix ?? "Meeting summary"}: ${input.subject}`, text, html };
}

function resolveSections(input: SummaryEmailInput): Array<{ label: string; items: string[] }> {
  const values = {
    summary: input.summary.summary,
    decisions: input.summary.decisions,
    actionItems: input.summary.actionItems.map((item) => [item.owner, item.task, item.dueDate].filter(Boolean).join(" - ")),
    openQuestions: input.summary.openQuestions,
    risks: input.summary.risks,
    followUps: input.summary.followUps
  };
  const defaultSections: NonNullable<SummaryEmailInput["recap"]>["sections"] = [
    { key: "summary", label: "Summary", enabled: true },
    { key: "decisions", label: "Decisions", enabled: true },
    { key: "actionItems", label: "Action items", enabled: true },
    { key: "openQuestions", label: "Open questions", enabled: true },
    { key: "risks", label: "Risks", enabled: true },
    { key: "followUps", label: "Follow-ups", enabled: true }
  ];
  return (input.recap?.sections ?? defaultSections)
    .filter((section) => section.enabled)
    .map((section) => ({ label: section.label, items: values[section.key] }));
}

function sectionText(title: string, items: string[]): string {
  if (items.length === 0) return `${title}\n- None\n`;
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function sectionHtml(title: string, items: string[]): string {
  const listItems = (items.length ? items : ["None"]).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `${heading(title)}<ul>${listItems}</ul>`;
}

function heading(value: string): string {
  return `<h2>${escapeHtml(value)}</h2>`;
}

function paragraph(value: string): string {
  return `<p>${escapeHtml(value)}</p>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
