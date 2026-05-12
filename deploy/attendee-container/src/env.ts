export type AttendeeContainerSettings = {
  ATTENDEE_WEB_INSTANCES?: string;
  ATTENDEE_CONTAINER_SLEEP_AFTER?: string;
  DJANGO_SETTINGS_MODULE?: string;
  DATABASE_URL?: string;
  REDIS_URL?: string;
  DJANGO_SECRET_KEY?: string;
  CREDENTIALS_ENCRYPTION_KEY?: string;
  SECRET_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_RECORDING_STORAGE_BUCKET_NAME?: string;
  AWS_ENDPOINT_URL?: string;
  AWS_STORAGE_BUCKET_NAME?: string;
  AWS_S3_ENDPOINT_URL?: string;
  AWS_S3_REGION_NAME?: string;
  EMAIL_HOST_USER?: string;
  EMAIL_HOST_PASSWORD?: string;
  DEEPGRAM_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL_NAME?: string;
  ZOOM_CLIENT_ID?: string;
  ZOOM_CLIENT_SECRET?: string;
  ATTENDEE_OPS_TOKEN?: string;
};

const requiredSettings = ["DATABASE_URL", "REDIS_URL", "DJANGO_SECRET_KEY", "CREDENTIALS_ENCRYPTION_KEY"] as const;

export type RuntimeStatus = {
  ok: boolean;
  runtime: "cloudflare-containers";
  missing: string[];
};

export function buildContainerEnv(env: AttendeeContainerSettings): Record<string, string> {
  const result: Record<string, string> = {
    DJANGO_SETTINGS_MODULE: env.DJANGO_SETTINGS_MODULE || "attendee.settings.production"
  };

  const mappedEnv: Record<string, string | undefined> = {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    DJANGO_SECRET_KEY: env.DJANGO_SECRET_KEY || env.SECRET_KEY,
    CREDENTIALS_ENCRYPTION_KEY: env.CREDENTIALS_ENCRYPTION_KEY,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    AWS_RECORDING_STORAGE_BUCKET_NAME: env.AWS_RECORDING_STORAGE_BUCKET_NAME || env.AWS_STORAGE_BUCKET_NAME,
    AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL || env.AWS_S3_ENDPOINT_URL,
    AWS_S3_REGION_NAME: env.AWS_S3_REGION_NAME,
    EMAIL_HOST_USER: env.EMAIL_HOST_USER,
    EMAIL_HOST_PASSWORD: env.EMAIL_HOST_PASSWORD,
    DEEPGRAM_API_KEY: env.DEEPGRAM_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_MODEL_NAME: env.OPENAI_MODEL_NAME,
    ZOOM_CLIENT_ID: env.ZOOM_CLIENT_ID,
    ZOOM_CLIENT_SECRET: env.ZOOM_CLIENT_SECRET
  };

  for (const [key, value] of Object.entries(mappedEnv)) {
    if (value) result[key] = value;
  }

  return result;
}

export function missingSettings(env: AttendeeContainerSettings): string[] {
  return requiredSettings.filter((key) => {
    if (key === "DJANGO_SECRET_KEY") return !env.DJANGO_SECRET_KEY && !env.SECRET_KEY;
    return !env[key];
  });
}

export function runtimeStatus(env: AttendeeContainerSettings): RuntimeStatus {
  const missing = missingSettings(env);
  return {
    ok: missing.length === 0,
    runtime: "cloudflare-containers",
    missing
  };
}

export async function isAuthorizedOpsRequest(request: Request, env: Pick<AttendeeContainerSettings, "ATTENDEE_OPS_TOKEN">): Promise<boolean> {
  if (!env.ATTENDEE_OPS_TOKEN) return false;
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme.toLowerCase() !== "bearer" || !token) return false;
  return constantTimeEqual(token, env.ATTENDEE_OPS_TOKEN);
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) diff |= leftBytes[index] ^ rightBytes[index];
  await crypto.subtle.digest("SHA-256", leftBytes);
  return diff === 0;
}
