import type { AppSettings } from "@minutesbot/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
export const ADMIN_TOKEN_STORAGE_KEY = "minutesbot.adminToken";
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

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export type SettingsView = {
  settings: AppSettings;
  /** Presence flags only — secret values never leave the worker. */
  secrets: {
    aiKeyConfigured: boolean;
    transcriptionKeyConfigured: boolean;
    botInternalTokenConfigured: boolean;
    sessionSecretConfigured: boolean;
  };
};

export async function getSettings(): Promise<SettingsView> {
  return apiGet<SettingsView>("/api/settings");
}

export async function saveSettings(settings: AppSettings): Promise<SettingsView> {
  return apiPut<SettingsView>("/api/settings", settings);
}

export async function uploadBotImage(input: { contentType: string; data: string; fileName: string }): Promise<SettingsView> {
  return apiPost<SettingsView>("/api/settings/bot-image", input);
}

/** Fetches artifact bytes with the admin bearer header so download links never embed the token. */
export async function fetchArtifactBlob(artifactId: string): Promise<Blob> {
  const token = authTokenProvider ? await authTokenProvider() : null;
  const response = await fetch(`${API_BASE}/api/artifacts/${encodeURIComponent(artifactId)}/content`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) {
    throw new ApiError(`Artifact download failed with ${response.status}`, response.status);
  }
  return response.blob();
}

export async function verifyAdminToken(token: string): Promise<{ ok: boolean; status: number }> {
  const response = await fetch(`${API_BASE}/api/admin/status`, {
    headers: { authorization: `Bearer ${token}` }
  });
  return { ok: response.ok, status: response.status };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = authTokenProvider ? await authTokenProvider() : null;
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const data = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string }; message?: string } | null;
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    }
    const message = data?.error?.message ?? data?.message ?? `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, data?.error?.code);
  }
  return data as T;
}
