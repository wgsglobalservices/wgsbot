import { describe, expect, it, vi } from "vitest";
import {
  buildRecapUserPrompt,
  buildRepairPrompt,
  chunkTranscript,
  generateRecap,
  RecapError,
  recapDocumentSchema,
  recapSystemPrompt,
  type RecapDocument
} from "./index";

const validRecap: RecapDocument = {
  overview: "The team agreed on the Friday launch plan.",
  decisions: ["Launch on Friday."],
  actionItems: [{ task: "Prepare release notes", owner: "Alex", dueDate: "Friday", timestampSeconds: 120 }],
  risks: ["QA capacity is tight."],
  openQuestions: ["Who covers support over the weekend?"],
  importantDates: [{ date: "Friday", description: "Launch day" }],
  followUps: ["Schedule the post-launch review."]
};

const config = { model: "gpt-5.5", apiKey: "sk-test-secret" };
const meeting = { subject: "Launch sync", startTime: "2026-06-12T15:00:00Z", durationMinutes: 30, attendeeNames: ["Alex", "Blair"] };

function completionResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fetchReturning(...contents: string[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const content of contents) {
    fetchImpl.mockResolvedValueOnce(completionResponse(content));
  }
  return fetchImpl;
}

type FetchMock = ReturnType<typeof fetchReturning>;

function requestInit(fetchImpl: FetchMock, callIndex: number): RequestInit {
  return fetchImpl.mock.calls[callIndex][1] as RequestInit;
}

function requestBody(fetchImpl: FetchMock, callIndex: number): { messages: Array<{ role: string; content: string }>; response_format?: unknown } {
  return JSON.parse(requestInit(fetchImpl, callIndex).body as string);
}

describe("generateRecap", () => {
  it("returns a validated recap on the first try", async () => {
    const fetchImpl = fetchReturning(JSON.stringify(validRecap));
    const result = await generateRecap({ transcriptText: "Alex: we launch Friday.", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.recap).toEqual(validRecap);
    expect(result.provider).toBe("openai-compatible");
    expect(result.model).toBe("gpt-5.5");
    expect(result.repaired).toBe(false);
    expect(result.chunked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = requestBody(fetchImpl, 0);
    expect(body.messages[0].content).toBe(recapSystemPrompt);
    expect(requestInit(fetchImpl, 0).headers).toMatchObject({ authorization: "Bearer sk-test-secret" });
  });

  it("parses markdown-fenced JSON", async () => {
    const fetchImpl = fetchReturning("```json\n" + JSON.stringify(validRecap) + "\n```");
    const result = await generateRecap({ transcriptText: "Alex: we launch Friday.", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.recap.overview).toBe(validRecap.overview);
    expect(result.repaired).toBe(false);
  });

  it("repairs invalid output on a second call carrying the zod issues", async () => {
    const invalid = JSON.stringify({ ...validRecap, overview: "" });
    const fetchImpl = fetchReturning(invalid, JSON.stringify(validRecap));
    const result = await generateRecap({ transcriptText: "Alex: we launch Friday.", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.repaired).toBe(true);
    expect(result.recap).toEqual(validRecap);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const repairMessages = requestBody(fetchImpl, 1).messages;
    const userMessage = repairMessages.find((message) => message.role === "user");
    expect(userMessage?.content).toContain("overview");
    expect(userMessage?.content).toContain("at least 1 character");
    expect(userMessage?.content).toContain(invalid.slice(0, 100));
  });

  it("fails non-retryably with redacted diagnostics when repair also fails", async () => {
    const transcriptText = "TRANSCRIPT-MARKER Alex talked about secrets.";
    const fetchImpl = fetchReturning("not json at all", "still not json");
    const error = await generateRecap({ transcriptText, meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecapError);
    const recapError = error as RecapError;
    expect(recapError.retryable).toBe(false);
    expect(recapError.diagnostics).toBeTruthy();
    expect(recapError.diagnostics).not.toContain("TRANSCRIPT-MARKER");
    expect(recapError.diagnostics).not.toContain("Bearer sk");
    expect(recapError.message).not.toContain("sk-test-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("classifies 429 as retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    const error = await generateRecap({ transcriptText: "hello", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecapError);
    expect((error as RecapError).retryable).toBe(true);
  });

  it("classifies 401 as non-retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const error = await generateRecap({ transcriptText: "hello", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecapError);
    expect((error as RecapError).retryable).toBe(false);
  });

  it("classifies network failures as retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const error = await generateRecap({ transcriptText: "hello", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RecapError);
    expect((error as RecapError).retryable).toBe(true);
  });

  it("redacts bearer tokens echoed in provider error bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Authorization "Bearer sk-test-secret" rejected', { status: 400 }));
    const error = (await generateRecap({ transcriptText: "hello", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught)) as RecapError;
    expect(error.retryable).toBe(false);
    expect(error.diagnostics).toContain("Bearer [REDACTED]");
    expect(error.diagnostics).not.toContain("sk-test-secret");
  });

  it("map-reduces transcripts over 40k chars and reports chunked=true", async () => {
    const transcriptText = ("Alex: status update line.\n\n").repeat(2_500); // ~67k chars
    expect(transcriptText.length).toBeGreaterThan(40_000);
    const chunkCount = chunkTranscript(transcriptText, 40_000).length;
    expect(chunkCount).toBeGreaterThan(1);
    const fetchImpl = fetchReturning(...Array.from({ length: chunkCount }, (_, index) => `Notes for segment ${index + 1}.`), JSON.stringify(validRecap));
    const result = await generateRecap({ transcriptText, meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.chunked).toBe(true);
    expect(result.repaired).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(chunkCount + 1);
    // Chunk calls are plain text; only the final recap call requests JSON.
    expect(requestBody(fetchImpl, 0).response_format).toBeUndefined();
    const finalBody = requestBody(fetchImpl, chunkCount);
    expect(finalBody.response_format).toEqual({ type: "json_object" });
    expect(finalBody.messages[1].content).toContain("Notes for segment 1.");
  });

  it("rejects empty transcripts without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const error = (await generateRecap({ transcriptText: "   \n ", meeting, config, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught)) as RecapError;
    expect(error).toBeInstanceOf(RecapError);
    expect(error.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing model and apiKey without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const missingModel = (await generateRecap({ transcriptText: "hello", meeting, config: { model: " ", apiKey: "k" }, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught)) as RecapError;
    expect(missingModel.retryable).toBe(false);
    const missingKey = (await generateRecap({ transcriptText: "hello", meeting, config: { model: "m", apiKey: "" }, fetchImpl: fetchImpl as unknown as typeof fetch }).catch((caught: unknown) => caught)) as RecapError;
    expect(missingKey.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("prompts", () => {
  it("recapSystemPrompt names every schema field and forbids invention", () => {
    for (const field of ["overview", "decisions", "actionItems", "task", "owner", "dueDate", "timestampSeconds", "risks", "openQuestions", "importantDates", "date", "description", "followUps"]) {
      expect(recapSystemPrompt).toContain(field);
    }
    expect(recapSystemPrompt).toMatch(/never invent/i);
    expect(recapSystemPrompt).toMatch(/omit/i);
    expect(recapSystemPrompt).toMatch(/empty array/i);
    expect(recapSystemPrompt).toMatch(/Not enough information was discussed/);
    expect(recapSystemPrompt).toMatch(/markdown/i);
  });

  it("buildRecapUserPrompt includes meeting context when given", () => {
    const prompt = buildRecapUserPrompt(meeting, "the transcript body");
    expect(prompt).toContain("Launch sync");
    expect(prompt).toContain("2026-06-12T15:00:00Z");
    expect(prompt).toContain("30");
    expect(prompt).toContain("Alex, Blair");
    expect(prompt).toContain("the transcript body");
  });

  it("buildRecapUserPrompt omits absent context lines", () => {
    const prompt = buildRecapUserPrompt({}, "body");
    expect(prompt).not.toContain("Subject:");
    expect(prompt).not.toContain("Attendees:");
    expect(prompt).toContain("body");
  });

  it("buildRepairPrompt truncates the invalid output to 4000 chars and carries the issues", () => {
    const prompt = buildRepairPrompt("x".repeat(10_000), "overview: Required");
    expect(prompt).toContain("overview: Required");
    expect(prompt.length).toBeLessThan(5_000);
  });
});

describe("recapDocumentSchema", () => {
  it("accepts a minimal valid document", () => {
    const minimal = {
      overview: "Not enough information was discussed.",
      decisions: [],
      actionItems: [],
      risks: [],
      openQuestions: [],
      importantDates: [],
      followUps: []
    };
    expect(recapDocumentSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects action items missing a task", () => {
    const garbage = { ...validRecap, actionItems: [{ owner: "Alex" }] };
    expect(recapDocumentSchema.safeParse(garbage).success).toBe(false);
  });

  it("rejects wrongly typed fields", () => {
    expect(recapDocumentSchema.safeParse({ ...validRecap, decisions: "Launch Friday" }).success).toBe(false);
    expect(recapDocumentSchema.safeParse({ ...validRecap, actionItems: [{ task: "x", timestampSeconds: -5 }] }).success).toBe(false);
    expect(recapDocumentSchema.safeParse({ ...validRecap, importantDates: [{ date: "Friday" }] }).success).toBe(false);
    expect(recapDocumentSchema.safeParse({ ...validRecap, overview: "" }).success).toBe(false);
  });
});
