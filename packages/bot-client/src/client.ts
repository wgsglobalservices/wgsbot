import { BotClientError, retryableStatus } from "./errors";
import type { BotClientOptions, BotHealth, BotRecording, BotRun, BotTranscriptSegment, CreateBotInput } from "./types";

export class BotClient {
  private readonly baseUrl: string;
  private readonly internalToken: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: BotClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.internalToken = options.internalToken;
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  async createBot(input: CreateBotInput): Promise<BotRun> {
    return this.request<BotRun>("/api/v1/bots", {
      method: "POST",
      body: JSON.stringify({
        ...(input.rawOverrides ?? {}),
        meeting_url: input.meetingUrl,
        bot_name: input.botName,
        bot_image: input.botImage,
        bot_chat_message: input.botChatMessage ? { to: "everyone", message: input.botChatMessage } : undefined,
        recording_settings: input.recordingSettings ? { format: input.recordingSettings.format } : undefined,
        external_media_storage_settings: input.externalMediaStorageSettings
          ? {
              bucket_name: input.externalMediaStorageSettings.bucketName,
              recording_file_name: input.externalMediaStorageSettings.recordingFileName
            }
          : undefined,
        webhooks: input.webhooks,
        metadata: input.metadata
      })
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

  private async request<T>(path: string, init: RequestInit = {}, errorMapper = mapStatus): Promise<T> {
    const response = await this.rawRequest(path, init, errorMapper);

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async rawRequest(path: string, init: RequestInit = {}, errorMapper = mapStatus): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.internalToken ? { authorization: `Bearer ${this.internalToken}` } : {}),
      ...(init.headers as Record<string, string> | undefined)
    };
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers
    });

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
