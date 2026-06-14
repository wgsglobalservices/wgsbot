import {
  transcribeRecording,
  TranscriptionError,
  type AudioChunkSource,
  type TranscriptionConfig
} from "./index";

const baseConfig: TranscriptionConfig = {
  provider: "openai-whisper",
  model: "whisper-1",
  apiKey: "sk-test-secret"
};

function chunk(key: string, offsetSeconds: number, contentType = "audio/mpeg"): AudioChunkSource {
  return {
    key,
    offsetSeconds,
    load: async () => ({ data: new ArrayBuffer(8), contentType })
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

type FetchCall = { url: string; init: RequestInit };

function mockFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (url: any, init?: any) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

async function expectError(promise: Promise<unknown>): Promise<TranscriptionError> {
  try {
    await promise;
  } catch (error) {
    return error as TranscriptionError;
  }
  throw new Error("expected promise to reject");
}

function noopSleep() {
  const calls: number[] = [];
  const impl = async (ms: number) => {
    calls.push(ms);
  };
  return { impl, calls };
}

describe("transcribeRecording", () => {
  it("transcribes a single chunk with verbose_json", async () => {
    const { impl, calls } = mockFetch(() =>
      jsonResponse({
        text: "hello world",
        language: "en",
        duration: 12.5,
        segments: [
          { start: 0, end: 5, text: "hello" },
          { start: 5, end: 12.5, text: "world" }
        ]
      })
    );

    const result = await transcribeRecording({
      chunks: [chunk("rec/audio.mp3", 0)],
      config: baseConfig,
      fetchImpl: impl
    });

    expect(result.text).toBe("hello world");
    expect(result.language).toBe("en");
    expect(result.durationSeconds).toBe(12.5);
    expect(result.segments).toEqual([
      { startSeconds: 0, endSeconds: 5, text: "hello" },
      { startSeconds: 5, endSeconds: 12.5, text: "world" }
    ]);
    expect(result.provider).toBe("openai-whisper");
    expect(result.model).toBe("whisper-1");
    expect(result.chunkCount).toBe(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-secret");
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("verbose_json");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.mp3");
  });

  it("merges three chunks with offset adjustment and joined text", async () => {
    const bodies = [
      { text: "part one", duration: 60, segments: [{ start: 0, end: 60, text: "part one" }] },
      { text: "part two", duration: 60, segments: [{ start: 0, end: 60, text: "part two" }] },
      { text: "part three", duration: 30, segments: [{ start: 0, end: 30, text: "part three" }] }
    ];
    const { impl } = mockFetch((_call, index) => jsonResponse(bodies[index]));

    const result = await transcribeRecording({
      chunks: [chunk("c0", 0), chunk("c1", 60), chunk("c2", 120)],
      config: baseConfig,
      fetchImpl: impl
    });

    expect(result.text).toBe("part one\npart two\npart three");
    expect(result.segments).toEqual([
      { startSeconds: 0, endSeconds: 60, text: "part one" },
      { startSeconds: 60, endSeconds: 120, text: "part two" },
      { startSeconds: 120, endSeconds: 150, text: "part three" }
    ]);
    expect(result.durationSeconds).toBe(150);
    expect(result.chunkCount).toBe(3);
  });

  it("falls back to response_format=json when verbose_json is rejected", async () => {
    const { impl, calls } = mockFetch((call) => {
      const form = call.init.body as FormData;
      if (form.get("response_format") === "verbose_json") {
        return jsonResponse({ error: { message: "unknown field: response_format" } }, 400);
      }
      return jsonResponse({ text: "fallback text" });
    });

    const result = await transcribeRecording({
      chunks: [chunk("c0", 30)],
      config: {
        ...baseConfig,
        provider: "whisper-compatible",
        baseUrl: "https://whisper.internal.example"
      },
      fetchImpl: impl
    });

    expect(calls).toHaveLength(2);
    expect((calls[1].init.body as FormData).get("response_format")).toBe("json");
    expect(result.text).toBe("fallback text");
    expect(result.segments).toEqual([{ startSeconds: 30, endSeconds: 30, text: "fallback text" }]);
  });

  it("throws a terminal error on 401 and redacts Authorization", async () => {
    const { impl } = mockFetch(() =>
      jsonResponse({ error: 'invalid Authorization: "Bearer sk-test-secret"' }, 401)
    );

    const promise = transcribeRecording({
      chunks: [chunk("c0", 0)],
      config: baseConfig,
      fetchImpl: impl
    });

    await expect(promise).rejects.toMatchObject({
      name: "TranscriptionError",
      retryable: false,
      status: 401,
      chunkKey: "c0"
    });
    const error = await expectError(promise);
    expect(error.message).not.toContain("sk-test-secret");
    expect(error.message).toContain("Bearer [redacted]");
    expect(error.message).toContain("401");
  });

  it("retries 429 with backoff and succeeds", async () => {
    const { impl } = mockFetch((_call, index) =>
      index === 0
        ? jsonResponse({ error: "rate limited" }, 429)
        : jsonResponse({ text: "after retry", duration: 5 })
    );
    const sleep = noopSleep();

    const result = await transcribeRecording({
      chunks: [chunk("c0", 0)],
      config: baseConfig,
      fetchImpl: impl,
      sleepImpl: sleep.impl
    });

    expect(result.text).toBe("after retry");
    expect(sleep.calls).toEqual([1000]);
  });

  it("throws retryable error with chunkKey after exhausting attempts on 500", async () => {
    const { impl, calls } = mockFetch(() => jsonResponse({ error: "boom" }, 500));
    const sleep = noopSleep();

    const error = await expectError(transcribeRecording({
      chunks: [chunk("rec/part-2.mp3", 600)],
      config: baseConfig,
      fetchImpl: impl,
      sleepImpl: sleep.impl
    }));

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(500);
    expect(error.chunkKey).toBe("rec/part-2.mp3");
    expect(calls).toHaveLength(3);
    expect(sleep.calls).toEqual([1000, 2000]);
  });

  it("retries network errors and classifies them retryable", async () => {
    const { impl, calls } = mockFetch(() => {
      throw new Error("socket hang up");
    });
    const sleep = noopSleep();

    const error = await expectError(transcribeRecording({
      chunks: [chunk("c0", 0)],
      config: baseConfig,
      fetchImpl: impl,
      sleepImpl: sleep.impl
    }));

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.retryable).toBe(true);
    expect(error.chunkKey).toBe("c0");
    expect(calls).toHaveLength(3);
    expect(sleep.calls).toEqual([1000, 2000]);
  });

  it("rejects empty apiKey", async () => {
    const error = await expectError(transcribeRecording({
      chunks: [chunk("c0", 0)],
      config: { ...baseConfig, apiKey: "" },
      fetchImpl: mockFetch(() => jsonResponse({ text: "x" })).impl
    }));

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("apiKey");
  });

  it("rejects whisper-compatible without baseUrl", async () => {
    const error = await expectError(transcribeRecording({
      chunks: [chunk("c0", 0)],
      config: { ...baseConfig, provider: "whisper-compatible" },
      fetchImpl: mockFetch(() => jsonResponse({ text: "x" })).impl
    }));

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("baseUrl");
  });

  it("rejects empty chunks array", async () => {
    const error = await expectError(transcribeRecording({
      chunks: [],
      config: baseConfig,
      fetchImpl: mockFetch(() => jsonResponse({ text: "x" })).impl
    }));

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("chunks");
  });

  it("throws a terminal error when the response fails validation", async () => {
    const { impl } = mockFetch(() => jsonResponse({ transcript: "wrong shape" }));

    const error = await expectError(transcribeRecording({
      chunks: [chunk("c0", 0)],
      config: baseConfig,
      fetchImpl: impl
    }));

    expect(error).toBeInstanceOf(TranscriptionError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Invalid provider response");
    expect(error.chunkKey).toBe("c0");
  });
});
