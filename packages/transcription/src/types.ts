export type TranscriptionProvider = "openai-whisper" | "whisper-compatible";

export type TranscriptionConfig = {
  provider: TranscriptionProvider;
  baseUrl?: string;
  model: string;
  apiKey: string;
  language?: string;
};

export type AudioChunkSource = {
  key: string;
  offsetSeconds: number;
  load: () => Promise<{ data: ArrayBuffer; contentType: string }>;
};

export type TranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type TranscriptResult = {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  durationSeconds?: number;
  provider: TranscriptionProvider;
  model: string;
  chunkCount: number;
};

export class TranscriptionError extends Error {
  retryable: boolean;
  status?: number;
  chunkKey?: string;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; chunkKey?: string }
  ) {
    super(message);
    this.name = "TranscriptionError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.chunkKey = options.chunkKey;
  }
}
