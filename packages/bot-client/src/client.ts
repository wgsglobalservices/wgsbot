import { BotClientError, retryableStatus } from "./errors";
import type { BotClientOptions, BotHealth, BotRecording, BotRun, BotTranscriptSegment, CreateBotInput } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class BotClient {
  private readonly baseUrl: string;
  private readonly internalToken: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BotClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.internalToken = options.internalToken;
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async createBot(input: CreateBotInput): Promise<BotRun> {
    // Named fields first with undefined values stripped, then rawOverrides
    // applied on top — overrides must actually override (the previous spread
    // order silently discarded any override that had a named counterpart).
    const payload: Record<string, unknown> = {
      meeting_url: input.meetingUrl,
      bot_name: input.botName,
      bot_image: input.botImage,
      bot_chat_message: input.botChatMessage ? { to: "everyone", message: input.botChatMessage } : undefined,
      join_timeout_seconds: input.joinTimeoutSeconds,
      recording_settings: input.recordingSettings ? { format: input.recordingSettings.format } : undefined,
      external_media_storage_settings: input.externalMediaStorageSettings
        ? {
            bucket_name: input.externalMediaStorageSettings.bucketName,
            recording_file_name: input.externalMediaStorageSettings.recordingFileName
          }
        : undefined,
      webhooks: input.webhooks,
      metadata: input.metadata
    };
    for (const key of Object.keys(payload)) {
      if (payload[key] === undefined) delete payload[key];
    }
    Object.assign(payload, input.rawOverrides ?? {});
    return this.request<BotRun>("/api/v1/bots", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async checkHealth(): Promise<BotHealth> {
    const health = await this.request<BotHealth>("/_ops/health", {}, mapHealthError);
    if (!health.ok) throw new BotClientError(healthFailureMessage(health), 503, true, "BOT_UNHEALTHY");
    return health;
  }

  async getBot(botId: string): Promise<BotRun> {
    return this.request<BotRun>(`/api/v1/bots/${encodeURIComponent(botId)}`);
  }

  async getBotTranscript(botId: string, options: { force?: boolean } = {}): Promise<BotTranscriptSegment[]> {
    const params = new URLSearchParams();
    if (options.force) params.set("force", "true");
    const serializedParams = params.toString();
    const query = serializedParams ? `?${serializedParams}` : "";
    return this.request<BotTranscriptSegment[]>(`/api/v1/bots/${encodeURIComponent(botId)}/transcript${query}`);
  }

  async getBotRecording(botId: string): Promise<BotRecording> {
    const response = await this.rawRequest(`/api/v1/bots/${encodeURIComponent(botId)}/recording`);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!isRecordingContentType(contentType)) {
      throw new BotClientError(`Meeting bot recording media is unavailable; received ${contentType}`, response.status, true, "BOT_RECORDING_UNAVAILABLE");
    }
    return {
      data: await response.arrayBuffer(),
      contentType,
      sizeBytes: numberHeader(response.headers.get("content-length"))
    };
  }

  async deleteBotData(botId: string): Promise<void> {
    await this.request<unknown>(`/api/v1/bots/${encodeURIComponent(botId)}/delete_data`, { method: "POST" });
  }

  async cancelBot(botId: string): Promise<BotRun> {
    return this.request<BotRun>(`/api/v1/bots/${encodeURIComponent(botId)}/cancel`, { method: "POST" });
  }

  private async request<T>(path: string, init: RequestInit = {}, errorMapper = mapStatus): Promise<T> {
    const response = await this.rawRequest(path, init, errorMapper);

    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      // A non-JSON 2xx body must surface as a typed client error so callers
      // branching on code/retryable keep working.
      throw new BotClientError("Meeting bot response was not valid JSON", response.status, true, "BOT_INVALID_RESPONSE");
    }
  }

  private async rawRequest(path: string, init: RequestInit = {}, errorMapper = mapStatus): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}),
      ...(init.headers as Record<string, string> | undefined)
    };
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        // A wedged runtime (e.g. a cold or hung container) must not hang the
        // calling queue consumer indefinitely.
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new BotClientError(`Meeting bot request timed out after ${this.timeoutMs}ms`, 408, true, "BOT_REQUEST_TIMEOUT");
      }
      throw error;
    }

    if (!response.ok) {
      const retryable = retryableStatus(response.status);
      let message = `Meeting bot request failed with ${response.status}`;
      if (path === "/_ops/health") message = healthFailureMessage(await readHealthResponse(response));
      throw new BotClientError(message, response.status, retryable, errorMapper(response.status));
    }

    return response;
  }
}

export { BotClient as AttendeeClient };

function numberHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecordingContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return Boolean(type && (type.startsWith("audio/") || type.startsWith("video/") || type === "application/octet-stream"));
}

export function normalizeBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).toString().replace(/\/+$/, "");
}

function mapStatus(status: number): string {
  if (status === 401 || status === 403) return "BOT_AUTH_FAILED";
  if (status === 404) return "BOT_NOT_FOUND";
  if (status === 409) return "BOT_CONFLICT";
  if (status === 429) return "BOT_RATE_LIMITED";
  if (status >= 500) return "BOT_UPSTREAM_ERROR";
  return "BOT_REQUEST_FAILED";
}

function mapHealthError(_status: number): string {
  return "BOT_UNHEALTHY";
}

async function readHealthResponse(response: Response): Promise<Partial<BotHealth>> {
  return ((await response.clone().json().catch(() => ({}))) ?? {}) as Partial<BotHealth>;
}

function healthFailureMessage(health: Partial<BotHealth>): string {
  const missing = Array.isArray(health.missing) && health.missing.length > 0 ? `: missing ${health.missing.join(", ")}` : "";
  return `Meeting bot health check failed${missing}`;
}
