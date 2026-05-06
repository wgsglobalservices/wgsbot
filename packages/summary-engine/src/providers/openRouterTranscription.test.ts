import { describe, expect, it, vi } from "vitest";
import { createOpenRouterTranscriptionProvider } from "./openRouterTranscription";

describe("OpenRouter transcription provider", () => {
  it("posts base64 audio to the OpenRouter transcription endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: "Alex: hello", usage: { seconds: 2.5 } }));
    const provider = createOpenRouterTranscriptionProvider({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "secret",
      model: "openai/whisper-large-v3",
      language: "en",
      fetcher
    });

    await expect(provider.transcribe(new Uint8Array([1, 2, 3]).buffer, "audio/wav")).resolves.toEqual({
      text: "Alex: hello",
      usage: { seconds: 2.5 }
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
        body: JSON.stringify({
          input_audio: { data: "AQID", format: "wav" },
          model: "openai/whisper-large-v3",
          language: "en"
        })
      })
    );
  });
});
