import { AttendeeClientError, retryableStatus } from "./errors";
import type { AttendeeBot, AttendeeClientOptions, AttendeeHealth, AttendeeRecording, AttendeeTranscriptSegment, CreateAttendeeBotInput } from "./types";

export class AttendeeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(options: AttendeeClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  async createBot(input: CreateAttendeeBotInput): Promise<AttendeeBot> {
    return this.request<AttendeeBot>("/api/v1/bots", {
      method: "POST",
      body: JSON.stringify({
        ...(input.rawOverrides ?? {}),
        meeting_url: input.meetingUrl,
        bot_name: input.botName,
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

  async checkHealth(): Promise<AttendeeHealth> {
    if (isHostedAttendee(this.baseUrl)) {
      return this.checkHostedHealth();
    }

    const health = await this.request<AttendeeHealth>("/_ops/health", {}, mapHealthError);
    if (!health.ok) throw new AttendeeClientError(healthFailureMessage(health), 503, true, "ATTENDEE_UNHEALTHY");
    return health;
  }

  async getBot(botId: string): Promise<AttendeeBot> {
    return this.request<AttendeeBot>(`/api/v1/bots/${encodeURIComponent(botId)}`);
  }

  async getBotTranscript(botId: string, options: { force?: boolean } = {}): Promise<AttendeeTranscriptSegment[]> {
    const params = new URLSearchParams();
    if (options.force) params.set("force", "true");
    const serializedParams = params.toString();
    const query = serializedParams ? `?${serializedParams}` : "";
    return this.request<AttendeeTranscriptSegment[]>(`/api/v1/bots/${encodeURIComponent(botId)}/transcript${query}`);
  }

  async getBotRecording(botId: string): Promise<AttendeeRecording> {
    const response = await this.rawRequest(`/api/v1/bots/${encodeURIComponent(botId)}/recording`);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!isRecordingContentType(contentType)) {
      throw new AttendeeClientError(`Attendee recording media is unavailable; received ${contentType}`, response.status, true, "ATTENDEE_RECORDING_UNAVAILABLE");
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
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Token ${this.apiKey}`,
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      const retryable = retryableStatus(response.status);
      let message = `Attendee request failed with ${response.status}`;
      if (path === "/_ops/health") message = healthFailureMessage(await readHealthResponse(response));
      throw new AttendeeClientError(message, response.status, retryable, errorMapper(response.status));
    }

    return response;
  }

  private async checkHostedHealth(): Promise<AttendeeHealth> {
    try {
      await this.getBot("minutesbot-preflight");
    } catch (error) {
      if (error instanceof AttendeeClientError && error.code === "ATTENDEE_NOT_FOUND") {
        return { ok: true, runtime: "attendee-hosted", missing: [] };
      }
      throw error;
    }

    return { ok: true, runtime: "attendee-hosted", missing: [] };
  }
}

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
  if (status === 401 || status === 403) return "ATTENDEE_AUTH_FAILED";
  if (status === 404) return "ATTENDEE_NOT_FOUND";
  if (status === 409) return "ATTENDEE_CONFLICT";
  if (status === 429) return "ATTENDEE_RATE_LIMITED";
  if (status >= 500) return "ATTENDEE_UPSTREAM_ERROR";
  return "ATTENDEE_REQUEST_FAILED";
}

function mapHealthError(_status: number): string {
  return "ATTENDEE_UNHEALTHY";
}

function isHostedAttendee(baseUrl: string): boolean {
  return new URL(baseUrl).hostname === "app.attendee.dev";
}

async function readHealthResponse(response: Response): Promise<Partial<AttendeeHealth>> {
  return ((await response.clone().json().catch(() => ({}))) ?? {}) as Partial<AttendeeHealth>;
}

function healthFailureMessage(health: Partial<AttendeeHealth>): string {
  const missing = Array.isArray(health.missing) && health.missing.length > 0 ? `: missing ${health.missing.join(", ")}` : "";
  return `Attendee health check failed${missing}`;
}
