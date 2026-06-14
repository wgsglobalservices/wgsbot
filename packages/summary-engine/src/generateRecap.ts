import { chunkTranscript } from "./chunkTranscript";
import { buildCondensePrompt, buildRecapUserPrompt, buildRepairPrompt, condenseSystemPrompt, recapSystemPrompt } from "./prompts";
import { RecapError } from "./recapError";
import { recapDocumentSchema, type RecapDocument } from "./schema";

export type RecapConfig = {
  baseUrl?: string;
  model: string;
  apiKey: string;
};

export type RecapMeetingContext = {
  subject?: string;
  startTime?: string;
  durationMinutes?: number;
  attendeeNames?: string[];
};

export type RecapGenerationResult = {
  recap: RecapDocument;
  provider: "openai-compatible";
  model: string;
  repaired: boolean;
  chunked: boolean;
};

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// ~10,000 tokens at an estimated 4 chars/token.
const CHUNK_THRESHOLD_CHARS = 40_000;
const TIMEOUT_MS = 120_000;

export async function generateRecap(input: {
  transcriptText: string;
  meeting: RecapMeetingContext;
  config: RecapConfig;
  fetchImpl?: typeof fetch;
}): Promise<RecapGenerationResult> {
  const { transcriptText, meeting, config } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  if (!transcriptText || !transcriptText.trim()) {
    throw new RecapError("transcriptText must not be empty", false);
  }
  if (!config.model || !config.model.trim()) {
    throw new RecapError("config.model must not be empty", false);
  }
  if (!config.apiKey || !config.apiKey.trim()) {
    throw new RecapError("config.apiKey must not be empty", false);
  }
  const call = makeChatCaller(config, fetchImpl);

  // Map-reduce long transcripts into condensed plain-text notes first.
  const chunked = transcriptText.length > CHUNK_THRESHOLD_CHARS;
  let recapSource = transcriptText;
  if (chunked) {
    const chunks = chunkTranscript(transcriptText, CHUNK_THRESHOLD_CHARS);
    const notes: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const noteText = await call(
        [
          { role: "system", content: condenseSystemPrompt },
          { role: "user", content: buildCondensePrompt(index, chunks.length, chunks[index]) }
        ],
        false
      );
      if (noteText.trim()) notes.push(noteText.trim());
    }
    recapSource = notes.join("\n\n");
  }

  const firstOutput = await call(
    [
      { role: "system", content: recapSystemPrompt },
      { role: "user", content: buildRecapUserPrompt(meeting, recapSource) }
    ],
    true
  );
  const firstAttempt = tryParseRecap(firstOutput);
  if (firstAttempt.ok) {
    return { recap: firstAttempt.recap, provider: "openai-compatible", model: config.model, repaired: false, chunked };
  }

  // Single repair retry; the caller's job system owns any further retries.
  const repairedOutput = await call(
    [
      { role: "system", content: recapSystemPrompt },
      { role: "user", content: buildRepairPrompt(firstOutput, firstAttempt.issues) }
    ],
    true
  );
  const repairedAttempt = tryParseRecap(repairedOutput);
  if (repairedAttempt.ok) {
    return { recap: repairedAttempt.recap, provider: "openai-compatible", model: config.model, repaired: true, chunked };
  }
  throw new RecapError(
    "Recap output failed schema validation after a repair attempt",
    false,
    redactSecrets(`Output: ${repairedOutput.slice(0, 500)}\nIssues: ${repairedAttempt.issues}`)
  );
}

type ChatMessage = { role: "system" | "user"; content: string };

function makeChatCaller(config: RecapConfig, fetchImpl: typeof fetch): (messages: ChatMessage[], jsonResponse: boolean) => Promise<string> {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return async (messages, jsonResponse) => {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(jsonResponse ? { response_format: { type: "json_object" } } : {}),
          temperature: 0.2
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      // Status-only messaging: never echo request details that carry the key.
      throw new RecapError(`Recap provider request failed: ${error instanceof Error ? error.name : "unknown error"}`, true);
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => "");
      throw new RecapError(`Recap provider request failed with status ${response.status}`, retryable, redactSecrets(body.slice(0, 300)));
    }
    let payload: { choices?: Array<{ message?: { content?: string } }> };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      return "";
    }
    return payload.choices?.[0]?.message?.content ?? "";
  };
}

type ParseAttempt = { ok: true; recap: RecapDocument } | { ok: false; issues: string };

function tryParseRecap(content: string): ParseAttempt {
  // Strip Markdown fences defensively — not every OpenAI-compatible backend
  // honours response_format.
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, issues: `Output is not valid JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  const result = recapDocumentSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`).join("; ");
    return { ok: false, issues };
  }
  return { ok: true, recap: result.data };
}

function redactSecrets(text: string): string {
  return text.replace(/Bearer [^\s"]+/g, "Bearer [REDACTED]");
}
