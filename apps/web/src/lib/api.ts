import type { AppSettings } from "@minutesbot/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
let authTokenProvider: (() => Promise<string | null>) | null = null;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "REQUEST_FAILED") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function setApiAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  authTokenProvider = provider;
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export async function apiGetText(path: string): Promise<string> {
  const response = await fetchApi(path, {}, false);
  await throwIfApiError(response);
  return response.text();
}

export async function apiGetBlob(path: string): Promise<Blob> {
  const response = await fetchApi(path, {}, false);
  await throwIfApiError(response);
  return response.blob();
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export async function getSettings(): Promise<AppSettings> {
  return apiGet<AppSettings>("/api/settings");
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return apiPut<AppSettings>("/api/settings", settings);
}

export async function uploadBotImage(input: { contentType: string; data: string; fileName: string }): Promise<AppSettings> {
  return apiPost<AppSettings>("/api/settings/bot-image", input);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchApi(path, init, true);
  await throwIfApiError(response);
  const data = (await response.json().catch(() => null)) as T;
  return data;
}

async function fetchApi(path: string, init: RequestInit = {}, includeJsonContentType: boolean): Promise<Response> {
  const token = authTokenProvider ? await authTokenProvider() : null;
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(includeJsonContentType ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });
}

async function throwIfApiError(response: Response): Promise<void> {
  if (!response.ok) {
    const data = (await response.clone().json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    const message = data?.error?.message ?? `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, data?.error?.code);
  }
}
