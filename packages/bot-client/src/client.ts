import { BotClientError, retryableStatus } from "./errors";
import type {
  BotClientOptions,
  BotRuntimeDiagnostics,
  BotRuntimeHealth,
  BotRuntimeReadiness,
  CancelBotResult,
  CreateBotRuntimeInput,
  CreateBotRuntimeResult,
  RuntimeBotStatus
} from "./types";

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

  async createBot(input: CreateBotRuntimeInput): Promise<CreateBotRuntimeResult> {
    return this.request<CreateBotRuntimeResult>("/v1/bots", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async getBot(runtimeBotId: string): Promise<RuntimeBotStatus> {
    return this.request<RuntimeBotStatus>(`/v1/bots/${encodeURIComponent(runtimeBotId)}`);
  }

  async cancelBot(runtimeBotId: string): Promise<CancelBotResult> {
    return this.request<CancelBotResult>(`/v1/bots/${encodeURIComponent(runtimeBotId)}/cancel`, { method: "POST" });
  }

  async getDiagnostics(runtimeBotId: string): Promise<BotRuntimeDiagnostics> {
    return this.request<BotRuntimeDiagnostics>(`/v1/bots/${encodeURIComponent(runtimeBotId)}/diagnostics`);
  }

  /**
   * Returns the runtime health report. A 503 still carries the per-check
   * body, so callers can see exactly which dependency is missing instead of
   * getting an opaque error.
   */
  async checkHealth(): Promise<BotRuntimeHealth> {
    return this.request<BotRuntimeHealth>("/_ops/health", {}, { allowStatuses: [503] });
  }

  async checkReady(): Promise<BotRuntimeReadiness> {
    return this.request<BotRuntimeReadiness>("/_ops/ready", {}, { allowStatuses: [503] });
  }

  private async request<T>(path: string, init: RequestInit = {}, options: { allowStatuses?: number[] } = {}): Promise<T> {
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
      throw new BotClientError(
        `Meeting bot request failed: ${error instanceof Error ? error.message : String(error)}`,
        0,
        true,
        "BOT_NETWORK_ERROR"
      );
    }

    if (!response.ok && !options.allowStatuses?.includes(response.status)) {
      const detail = await readDetail(response);
      throw new BotClientError(
        requestFailureMessage(response.status, this.baseUrl, detail),
        response.status,
        retryableStatus(response.status),
        mapStatus(response.status)
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      // A non-JSON body must surface as a typed client error so callers
      // branching on code/retryable keep working.
      throw new BotClientError("Meeting bot response was not valid JSON", response.status, true, "BOT_INVALID_RESPONSE");
    }
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).toString().replace(/\/+$/, "");
}

async function readDetail(response: Response): Promise<string | null> {
  const body = (await response.clone().json().catch(() => null)) as { detail?: unknown } | null;
  return body && typeof body.detail === "string" ? body.detail : null;
}

function mapStatus(status: number): string {
  if (status === 401 || status === 403) return "BOT_AUTH_FAILED";
  if (status === 404) return "BOT_NOT_FOUND";
  if (status === 409) return "BOT_CONFLICT";
  if (status === 422) return "BOT_INVALID_MEETING_URL";
  if (status === 429) return "BOT_RATE_LIMITED";
  if (status === 530) return "BOT_RUNTIME_DOMAIN_UNAVAILABLE";
  if (status >= 500) return "BOT_UPSTREAM_ERROR";
  return "BOT_REQUEST_FAILED";
}

function requestFailureMessage(status: number, baseUrl: string, detail: string | null): string {
  if (status === 530) {
    const hostname = new URL(baseUrl).hostname;
    return `Meeting bot runtime domain ${hostname} is unavailable through Cloudflare (530). Deploy the bot container with pnpm bot:deploy and verify the custom domain/DNS routes to the bot runtime.`;
  }
  return `Meeting bot request failed with ${status}${detail ? `: ${detail}` : ""}`;
}
