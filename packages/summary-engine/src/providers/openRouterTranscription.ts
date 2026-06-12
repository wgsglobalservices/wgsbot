import type { TranscriptionProvider, TranscriptionResult } from "../types";

export type OpenRouterTranscriptionOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function createOpenRouterTranscriptionProvider(options: OpenRouterTranscriptionOptions): TranscriptionProvider {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async transcribe(audio: ArrayBuffer, contentType: string): Promise<TranscriptionResult> {
      const body: Record<string, unknown> = {
        input_audio: {
          data: arrayBufferToBase64(audio),
          format: audioFormat(contentType)
        },
        model: options.model
      };
      if (options.language) body.language = options.language;
      const response = await fetcher(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`OpenRouter transcription failed with ${response.status}`);
      const payload = (await response.json()) as TranscriptionResult;
      // An empty string is a legitimate transcription of a silent recording;
      // only a missing field is a provider contract failure.
      if (typeof payload.text !== "string") throw new Error("OpenRouter transcription returned no text");
      return payload;
    }
  };
}

function audioFormat(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "video/mp4") return "mp4";
  if (!type?.startsWith("audio/")) return "mp3";
  const subtype = type.slice("audio/".length);
  if (subtype === "mpeg") return "mp3";
  if (subtype === "x-m4a") return "m4a";
  return subtype || "mp3";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // Chunked conversion: per-byte string concatenation on a multi-megabyte
  // recording is quadratic and blows Worker CPU/memory limits.
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(parts.join(""));
}
