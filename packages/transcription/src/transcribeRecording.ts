import { z } from "zod";
import {
  AudioChunkSource,
  TranscriptionConfig,
  TranscriptionError,
  TranscriptResult,
  TranscriptSegment
} from "./types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MAX_ATTEMPTS = 3;

const configSchema = z
  .object({
    provider: z.enum(["openai-whisper", "whisper-compatible"]),
    baseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), {
        message: "baseUrl must be an https URL"
      })
      .optional(),
    model: z.string().min(1, "model must be non-empty"),
    apiKey: z.string().min(1, "apiKey must be non-empty"),
    language: z.string().optional()
  })
  .refine((value) => value.provider !== "whisper-compatible" || value.baseUrl !== undefined, {
    message: 'provider "whisper-compatible" requires an explicit baseUrl'
  });

const responseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  duration: z.number().optional(),
  segments: z
    .array(
      z.object({
        start: z.number(),
        end: z.number(),
        text: z.string()
      })
    )
    .optional()
});

type WhisperResponse = z.infer<typeof responseSchema>;

const CONTENT_TYPE_FILENAMES: Record<string, string> = {
  "audio/mpeg": "audio.mp3",
  "audio/wav": "audio.wav",
  "audio/webm": "audio.webm",
  "audio/mp4": "audio.mp4"
};

function filenameForContentType(contentType: string): string {
  const base = contentType.split(";")[0].trim().toLowerCase();
  return CONTENT_TYPE_FILENAMES[base] ?? "audio.mp3";
}

function redactBody(body: string): string {
  return body.replace(/Bearer [^\s"]+/g, "Bearer [redacted]").slice(0, 200);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribeRecording(input: {
  chunks: AudioChunkSource[];
  config: TranscriptionConfig;
  fetchImpl?: typeof fetch;
  maxAttemptsPerChunk?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<TranscriptResult> {
  const parsedConfig = configSchema.safeParse(input.config);
  if (!parsedConfig.success) {
    const detail = parsedConfig.error.issues.map((issue) => issue.message).join("; ");
    throw new TranscriptionError(`Invalid transcription config: ${detail}`, {
      retryable: false
    });
  }
  if (input.chunks.length === 0) {
    throw new TranscriptionError("Invalid transcription input: chunks must not be empty", {
      retryable: false
    });
  }

  const config = parsedConfig.data;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleep = input.sleepImpl ?? defaultSleep;
  const maxAttempts = input.maxAttemptsPerChunk ?? DEFAULT_MAX_ATTEMPTS;

  const segments: TranscriptSegment[] = [];
  const texts: string[] = [];
  let language: string | undefined;
  let durationSeconds: number | undefined;
  // Once a provider rejects verbose_json, stop asking for it.
  let verboseSupported = true;

  for (const chunk of input.chunks) {
    const { data, contentType } = await chunk.load();
    const filename = filenameForContentType(contentType);

    const request = async (responseFormat: "verbose_json" | "json"): Promise<Response> => {
      const form = new FormData();
      form.append("file", new Blob([data], { type: contentType }), filename);
      form.append("model", config.model);
      form.append("response_format", responseFormat);
      if (config.language !== undefined) {
        form.append("language", config.language);
      }
      return fetchImpl(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form
      });
    };

    let result: WhisperResponse | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      let networkError: unknown;
      try {
        response = await request(verboseSupported ? "verbose_json" : "json");
        if (
          !response.ok &&
          response.status === 400 &&
          verboseSupported
        ) {
          const body = await response.clone().text();
          if (/response_format|unknown (field|parameter)/i.test(body)) {
            verboseSupported = false;
            response = await request("json");
          }
        }
      } catch (error) {
        networkError = error;
        response = undefined as never;
      }

      if (networkError !== undefined) {
        if (attempt < maxAttempts) {
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        const detail = networkError instanceof Error ? networkError.message : String(networkError);
        throw new TranscriptionError(
          `Transcription request failed for chunk "${chunk.key}" after ${maxAttempts} attempts: ${redactBody(detail)}`,
          { retryable: true, chunkKey: chunk.key }
        );
      }

      if (!response.ok) {
        const body = redactBody(await response.text());
        if (isRetryableStatus(response.status)) {
          if (attempt < maxAttempts) {
            await sleep(1000 * 2 ** (attempt - 1));
            continue;
          }
          throw new TranscriptionError(
            `Transcription failed for chunk "${chunk.key}" after ${maxAttempts} attempts: HTTP ${response.status}: ${body}`,
            { retryable: true, status: response.status, chunkKey: chunk.key }
          );
        }
        throw new TranscriptionError(
          `Transcription failed for chunk "${chunk.key}": HTTP ${response.status}: ${body}`,
          { retryable: false, status: response.status, chunkKey: chunk.key }
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        throw new TranscriptionError(
          `Invalid provider response for chunk "${chunk.key}": body is not valid JSON`,
          { retryable: false, status: response.status, chunkKey: chunk.key }
        );
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        throw new TranscriptionError(
          `Invalid provider response for chunk "${chunk.key}": ${detail}`,
          { retryable: false, status: response.status, chunkKey: chunk.key }
        );
      }
      result = parsed.data;
      break;
    }

    // result is always set here: the loop either assigns it or throws.
    const data2 = result as WhisperResponse;
    texts.push(data2.text);
    if (language === undefined && data2.language !== undefined) {
      language = data2.language;
    }
    if (data2.duration !== undefined) {
      const end = chunk.offsetSeconds + data2.duration;
      durationSeconds = durationSeconds === undefined ? end : Math.max(durationSeconds, end);
    }
    if (data2.segments !== undefined && data2.segments.length > 0) {
      for (const segment of data2.segments) {
        segments.push({
          startSeconds: segment.start + chunk.offsetSeconds,
          endSeconds: segment.end + chunk.offsetSeconds,
          text: segment.text
        });
      }
    } else {
      segments.push({
        startSeconds: chunk.offsetSeconds,
        endSeconds: chunk.offsetSeconds + (data2.duration ?? 0),
        text: data2.text
      });
    }
  }

  return {
    text: texts.join("\n"),
    segments,
    language,
    durationSeconds,
    provider: config.provider,
    model: config.model,
    chunkCount: input.chunks.length
  };
}
