import { Container, getContainer } from "@cloudflare/containers";
import { env as workerEnv } from "cloudflare:workers";
import { limitReadableStream, timingSafeEqualString } from "@minutesbot/shared";

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

export class MeetingBotContainer extends Container {
  defaultPort = 8787;
  sleepAfter = getGlobal("BOT_CONTAINER_SLEEP_AFTER") || "24h";
  envVars = {
    ...stringEnv(workerEnv as BotContainerEnv),
    BOT_STORAGE_UPLOAD_URL: `${(workerEnv as BotContainerEnv).BOT_API_BASE_URL ?? ""}/internal/recordings`
  };
}

export default {
  async fetch(request: Request, env: BotContainerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/recordings" && request.method === "PUT") {
      return storeRecording(request, env);
    }
    const container = getContainer(env.MEETING_BOT, env.BOT_CONTAINER_INSTANCE_ID || "primary");
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
  if (!bucket || bucket !== env.BOT_RECORDING_BUCKET_NAME || !isRecordingKey(key)) {
    return Response.json({ detail: "Invalid recording target" }, { status: 400 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RECORDING_UPLOAD_BYTES) {
    return Response.json({ detail: "Recording upload is too large" }, { status: 413 });
  }
  await env.ARTIFACTS.put(key, limitReadableStream(request.body, MAX_RECORDING_UPLOAD_BYTES), {
    httpMetadata: { contentType: request.headers.get("content-type") ?? "audio/mpeg" }
  });
  return Response.json({ ok: true, key });
}

function isRecordingKey(key: string): boolean {
  return /^recordings\/mtg_[a-z0-9]+\/recording\.mp3$/i.test(key);
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

function getGlobal(key: "BOT_CONTAINER_SLEEP_AFTER"): string | undefined {
  return (workerEnv as BotContainerEnv)[key];
}
