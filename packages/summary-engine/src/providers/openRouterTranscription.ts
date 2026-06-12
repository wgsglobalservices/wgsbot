import type { TranscriptionProvider, TranscriptionResult } from "../types";

export type OpenRouterTranscriptionOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  language?: string;
  fetcher?: typeof fetch;
};

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
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`OpenRouter transcription failed with ${response.status}`);
      const payload = (await response.json()) as TranscriptionResult;
      if (!payload.text) throw new Error("OpenRouter transcription returned no text");
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
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}
