import { describe, expect, it } from "vitest";
import type { RecapDocument } from "@minutesbot/summary-engine";
import { renderRecapEmail } from "./renderRecapEmail";

const recap: RecapDocument = {
  overview: "The team aligned on the Q3 launch plan & owners.",
  decisions: ["Ship the beta on July 1"],
  actionItems: [
    { task: "Draft launch email", owner: "Alex", dueDate: "2026-06-20" },
    { task: "Update pricing page" }
  ],
  risks: ["Vendor contract not signed"],
  openQuestions: ["Who owns the rollback plan?"],
  importantDates: [{ date: "2026-07-01", description: "Beta launch" }],
  followUps: ["Schedule pricing review"]
};

describe("renderRecapEmail", () => {
  it("renders subject, text, and html with all sections", () => {
    const rendered = renderRecapEmail({
      subject: "Project sync",
      startTime: "2026-06-16T14:00:00.000Z",
      timeZone: "America/New_York",
      recap,
      subjectPrefix: "Meeting recap",
      excludedRecipients: ["vendor@external.org"],
      adminUrl: "https://app.example.com/occurrences/occ_1"
    });
    expect(rendered.subject).toBe("Meeting recap: Project sync");
    expect(rendered.text).toContain("Ship the beta on July 1");
    expect(rendered.text).toContain("Draft launch email — owner: Alex — due: 2026-06-20");
    expect(rendered.text).toContain("Not delivered to (outside allowed domains): vendor@external.org");
    expect(rendered.text).toContain("2026-07-01: Beta launch");
    expect(rendered.html).toContain("Ship the beta on July 1");
    expect(rendered.html).toContain("vendor@external.org");
    expect(rendered.html).toContain('href="https://app.example.com/occurrences/occ_1"');
    // Eastern time rendering of 14:00 UTC.
    expect(rendered.text).toContain("10:00");
  });

  it("omits empty sections", () => {
    const rendered = renderRecapEmail({
      subject: "Quiet meeting",
      recap: { ...recap, decisions: [], risks: [], openQuestions: [], importantDates: [], followUps: [], actionItems: [] }
    });
    expect(rendered.text).not.toContain("Decisions");
    expect(rendered.text).not.toContain("Risks");
    expect(rendered.html).not.toContain("Action items");
  });

  it("escapes html and strips header injection from subjects", () => {
    const rendered = renderRecapEmail({
      subject: "Sync <script>alert(1)</script>\r\nBcc: evil@x.com",
      recap: { ...recap, overview: "Discussed <b>bold</b> & 'quotes'" }
    });
    expect(rendered.subject).not.toContain("\n");
    expect(rendered.subject).toContain("Bcc:");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("&amp; &#39;quotes&#39;");
  });
});
