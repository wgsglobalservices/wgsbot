import { Container, getContainer } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";
import { timingSafeEqualString } from "@minutesbot/shared";

type BotContainerEnv = {
  MEETING_BOT: DurableObjectNamespace<MeetingBotContainer>;
  ARTIFACTS: R2Bucket;
  BOT_INTERNAL_TOKEN?: string;
  BOT_API_BASE_URL?: string;
  BOT_RECORDING_BUCKET_NAME?: string;
  BOT_RUNTIME_VERSION?: string;
  BOT_CONTAINER_SLEEP_AFTER?: string;
  BOT_CONTAINER_INSTANCE_ID?: string;
  BOT_WEBHOOK_BASE_URL?: string;
  BOT_ALLOW_GUEST_JOIN?: string;
};

const MAX_RECORDING_UPLOAD_BYTES = 200 * 1024 * 1024;
const BOT_RUNTIME_PORT = 8787;

export class MeetingBotContainer extends Container {
  defaultPort = BOT_RUNTIME_PORT;
  sleepAfter = getGlobal("BOT_CONTAINER_SLEEP_AFTER") || "24h";
  envVars = {
    ...stringEnv(workerEnv as BotContainerEnv),
    BOT_STORAGE_UPLOAD_URL: `${(workerEnv as BotContainerEnv).BOT_API_BASE_URL ?? ""}/internal/recordings`,
    // Restrict runtime webhook targets to the configured control-plane
    // origin so a createBot caller cannot exfiltrate the bearer token to an
    // arbitrary URL.
    ...webhookAllowedOrigins(workerEnv as BotContainerEnv)
  };
}

export default {
  async fetch(request: Request, env: BotContainerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/recordings" && request.method === "PUT") {
      return storeRecording(request, env);
    }
    const container = getContainer(env.MEETING_BOT, env.BOT_CONTAINER_INSTANCE_ID || "primary");
    await container.startAndWaitForPorts(BOT_RUNTIME_PORT, { instanceGetTimeoutMS: 30_000, portReadyTimeoutMS: 60_000 });
    return container.fetch(request);
  }
};

async function storeRecording(request: Request, env: BotContainerEnv): Promise<Response> {
  if (!env.BOT_INTERNAL_TOKEN) {
    return Response.json({ detail: "Recording upload authorization is not configured" }, { status: 503 });
  }
  if (!timingSafeEqualString(request.headers.get("authorization") ?? "", `Bearer ${env.BOT_INTERNAL_TOKEN}`)) {
    return Response.json({ detail: "Unauthorized" }, { status: 401 });
  }
  const bucket = request.headers.get("x-recording-bucket");
  const key = request.headers.get("x-recording-key");
  if (!bucket || bucket !== env.BOT_RECORDING_BUCKET_NAME || !key || !isRecordingKey(key)) {
    return Response.json({ detail: "Invalid recording target" }, { status: 400 });
  }
  const length = Number(request.headers.get("content-length") ?? "");
  if (!Number.isFinite(length) || length <= 0) {
    return Response.json({ detail: "Recording upload requires a content-length" }, { status: 411 });
  }
  if (length > MAX_RECORDING_UPLOAD_BYTES) {
    return Response.json({ detail: "Recording upload is too large" }, { status: 413 });
  }
  if (!request.body) {
    return Response.json({ detail: "Recording upload requires a body" }, { status: 400 });
  }
  // R2 put() needs a stream with a known length; FixedLengthStream both
  // provides it and enforces that the body matches the declared size (an
  // arbitrary TransformStream here would make every upload fail).
  const fixed = new FixedLengthStream(length);
  void request.body.pipeTo(fixed.writable).catch(() => undefined);
  await env.ARTIFACTS.put(key, fixed.readable, {
    httpMetadata: { contentType: request.headers.get("content-type") ?? "audio/mpeg" }
  });
  return Response.json({ ok: true, key });
}

function isRecordingKey(key: string): boolean {
  // Uploads are confined to the recordings/ and diagnostics/ prefixes with
  // fixed file names — no traversal, no arbitrary writes. Mirrors
  // recordingKeyPattern in @minutesbot/shared.
  return (
    /^recordings\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/(recording|chunks\/chunk-\d{3})\.(mp3|mp4|webm|wav)$/.test(key) ||
    /^diagnostics\/[a-zA-Z0-9_-]+\/(screenshot\.png|page\.html|console\.log|bot\.log|visible-text\.txt|diagnostics\.json)$/.test(key)
  );
}

function stringEnv(env: BotContainerEnv): Record<string, string> {
  return Object.fromEntries(
    [
      "BOT_INTERNAL_TOKEN",
      "BOT_API_BASE_URL",
      "BOT_RECORDING_BUCKET_NAME",
      "BOT_RUNTIME_VERSION",
      "BOT_CONTAINER_INSTANCE_ID",
      "BOT_WEBHOOK_BASE_URL",
      "BOT_ALLOW_GUEST_JOIN"
    ]
      .map((key) => [key, env[key as keyof BotContainerEnv]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
  );
}

function webhookAllowedOrigins(env: BotContainerEnv): Record<string, string> {
  if (!env.BOT_WEBHOOK_BASE_URL) return {};
  try {
    return { BOT_WEBHOOK_ALLOWED_ORIGINS: new URL(env.BOT_WEBHOOK_BASE_URL).origin };
  } catch {
    return {};
  }
}

function getGlobal(key: "BOT_CONTAINER_SLEEP_AFTER"): string | undefined {
  return (workerEnv as BotContainerEnv)[key];
}
