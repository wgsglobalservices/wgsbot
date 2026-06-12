import type { SummaryProvider } from "../types";

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRYABLE_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): SummaryProvider {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async generate(prompt: string): Promise<unknown> {
      let lastError: Error = new Error("AI provider request failed");
      for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt += 1) {
        let response: Response;
        try {
          response = await fetcher(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${options.apiKey}`
            },
            body: JSON.stringify({
              model: options.model,
              messages: [
                { role: "system", content: "Return strict JSON meeting notes." },
                { role: "user", content: prompt }
              ],
              response_format: { type: "json_object" }
            }),
            signal: AbortSignal.timeout(timeoutMs)
          });
        } catch (error) {
          // Error messages stay status-only: never echo provider bodies that
          // could carry key material.
          lastError = new Error(`AI provider request failed: ${error instanceof Error ? error.name : "unknown error"}`);
          await retryDelay(attempt);
          continue;
        }
        if (!response.ok) {
          lastError = new Error(`AI provider failed with ${response.status}`);
          // Rate limits and upstream errors are worth retrying; client
          // errors are not.
          if (response.status === 429 || response.status >= 500) {
            await retryDelay(attempt);
            continue;
          }
          throw lastError;
        }
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = payload.choices?.[0]?.message?.content;
        if (!content) throw new Error("AI provider returned no content");
        return parseModelJson(content);
      }
      throw lastError;
    }
  };
}

/**
 * Parses model output as JSON, tolerating Markdown code fences — not every
 * OpenAI-compatible backend honours response_format.
 */
export function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fenced) {
      return JSON.parse(fenced[1]);
    }
    throw new Error("AI provider returned non-JSON content");
  }
}

async function retryDelay(attempt: number): Promise<void> {
  if (attempt < RETRYABLE_ATTEMPTS) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
  }
}
