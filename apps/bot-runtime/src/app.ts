import { Hono } from "hono";
import { z } from "zod";
import { normalizeTeamsJoinUrl } from "@minutesbot/invite-parser";
import {
  isTerminalBotSessionState,
  timingSafeEqualString,
  type BotSessionState,
  type JoinFailureStage
} from "@minutesbot/shared";

type RuntimeEnv = {
  BOT_INTERNAL_TOKEN?: string;
  BOT_RUNTIME_VERSION?: string;
  BOT_CONTAINER_INSTANCE_ID?: string;
  BOT_ALLOW_GUEST_JOIN?: string;
  BOT_MAX_CONCURRENT_SESSIONS?: string;
  BOT_HEARTBEAT_SECONDS?: string;
  BOT_WEBHOOK_RETRY_DELAY_MS?: string;
  BOT_UPLOAD_RETRY_DELAY_MS?: string;
  /**
   * Comma-separated list of origins webhooks may target. When set, createBot
   * rejects webhook URLs outside this list so a caller cannot point the
   * runtime (and its bearer token) at an attacker-controlled endpoint.
   */
  BOT_WEBHOOK_ALLOWED_ORIGINS?: string;
};

const WEBHOOK_DELIVERY_ATTEMPTS = 3;
const DEFAULT_WEBHOOK_RETRY_DELAY_MS = 2_000;
const UPLOAD_ATTEMPTS = 3;
const DEFAULT_UPLOAD_RETRY_DELAY_MS = 5_000;
const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
const DEFAULT_HEARTBEAT_SECONDS = 60;
const DEFAULT_CHUNK_THRESHOLD_BYTES = 20 * 1024 * 1024;
const CHUNK_SECONDS = 10 * 60;
const LOG_TAIL_LIMIT = 200;
const MAX_CREATE_BOT_BODY_BYTES = 1024 * 1024;

export type BotFailureStage = JoinFailureStage;

/** Page artifacts captured by the recorder before its cleanup runs. */
export type RecorderDiagnostics = {
  screenshotPng?: Uint8Array;
  pageHtml?: string;
  consoleLines?: string[];
  visibleText?: string;
};

/**
 * Classified recorder failure. `retryable` controls the recorder's internal
 * join retry loop; `stage` is emitted as failureStage in webhooks.
 */
export class BotRecorderError extends Error {
  constructor(
    message: string,
    readonly stage: BotFailureStage,
    readonly retryable: boolean,
    readonly diagnostics?: RecorderDiagnostics
  ) {
    super(message);
    this.name = "BotRecorderError";
  }
}

/** Thrown by the default uploadArtifact so retry logic can skip 4xx. */
export class UploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Upload failed with ${status}`);
    this.name = "UploadHttpError";
  }
}

export type RecorderState = "warming" | "browser_starting" | "prejoin" | "waiting_for_start" | "waiting_room" | "joined" | "recording";

export type BotRuntimeLog = {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
};

export type RecorderInput = {
  meetingUrl: string;
  displayName: string;
  joinTimeoutSeconds: number;
  maxDurationSeconds: number;
  allowGuestJoin: boolean;
  abortSignal?: AbortSignal;
  onState?: (state: RecorderState) => Promise<void>;
  onLog?: (log: BotRuntimeLog) => Promise<void>;
};

export type RecordingResult = {
  bytes: Uint8Array;
  contentType: string;
};

export type BotRuntimeDeps = {
  env: RuntimeEnv;
  checkBinary: (name: "chromium" | "ffmpeg" | "pulseaudio") => Promise<boolean>;
  checkTempWritable: () => Promise<boolean>;
  recorder: {
    record(input: RecorderInput): Promise<RecordingResult>;
  };
  splitRecording: (input: { bytes: Uint8Array; chunkSeconds: number }) => Promise<Uint8Array[]>;
  uploadArtifact: (input: { url: string; token: string; key: string; bytes: Uint8Array; contentType: string }) => Promise<void>;
  sendWebhook: (input: { url: string; token: string; body: string }) => Promise<void>;
  randomUUID?: () => string;
  now?: () => string;
};

const createBotSchema = z.object({
  botSessionId: z.string().trim().min(1),
  occurrenceId: z.string().trim().min(1),
  meetingUrl: z.string().trim().url(),
  displayName: z.string().trim().min(1),
  joinTimeoutSeconds: z.number().int().min(1).max(24 * 60 * 60),
  maxDurationSeconds: z.number().int().min(1).max(24 * 60 * 60),
  recording: z.object({ format: z.literal("mp3") }),
  webhook: z.object({ url: z.string().trim().url(), token: z.string().min(1) }),
  upload: z.object({
    url: z.string().trim().url(),
    token: z.string().min(1),
    recordingKey: z.string().trim().min(1),
    chunkKeyPrefix: z.string().trim().min(1).optional(),
    chunkThresholdBytes: z.number().int().min(1).optional()
  })
});

export type CreateBotInput = z.infer<typeof createBotSchema>;

type SessionRecord = {
  runtimeBotId: string;
  botSessionId: string;
  occurrenceId: string;
  state: BotSessionState;
  stateHistory: Array<{ state: BotSessionState; at: string }>;
  createdAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastHeartbeatAt: string;
  failureStage?: BotFailureStage;
  failureReason?: string;
  recordingKey?: string;
  recordingChunkKeys?: string[];
  diagnosticsKeys: string[];
  logEntries: string[];
  webhookSeq: number;
};

type SessionContext = {
  deps: BotRuntimeDeps;
  session: SessionRecord;
  input: CreateBotInput;
};

type HealthCheck = { ok: boolean; detail?: string };
type HealthChecks = {
  chromium: HealthCheck;
  ffmpeg: HealthCheck;
  pulseaudio: HealthCheck;
  tempWritable: HealthCheck;
  config: HealthCheck;
};

export function createBotRuntimeApp(deps: BotRuntimeDeps): Hono {
  const app = new Hono();
  const sessions = new Map<string, SessionRecord>();
  const controls = new Map<string, AbortController>();
  // Binary availability cannot change within a container's lifetime; caching
  // keeps the unauthenticated health endpoint from spawning processes (and
  // blocking the event loop shared with live recordings) on every request.
  let healthCache: Promise<HealthChecks> | null = null;
  const getHealth = () => (healthCache ??= computeHealthChecks(deps));

  app.get("/_ops/health", async (c) => {
    const checks = await getHealth();
    const ok = Object.values(checks).every((check) => check.ok);
    return c.json(
      {
        ok,
        version: runtimeVersion(deps.env),
        containerInstanceId: deps.env.BOT_CONTAINER_INSTANCE_ID?.trim() || "unknown",
        checks
      },
      ok ? 200 : 503
    );
  });

  app.get("/_ops/ready", async (c) => {
    const checks = await getHealth();
    const failing = Object.entries(checks)
      .filter(([, check]) => !check.ok)
      .map(([name]) => name);
    if (failing.length > 0) {
      return c.json({ ready: false, reason: `unhealthy: ${failing.join(", ")}` }, 503);
    }
    const live = liveSessionCount(sessions);
    const cap = maxConcurrentSessions(deps.env);
    if (live >= cap) {
      return c.json({ ready: false, reason: `at capacity (${live}/${cap} sessions)` }, 503);
    }
    return c.json({ ready: true });
  });

  app.use("/v1/*", async (c, next) => {
    const expected = deps.env.BOT_INTERNAL_TOKEN;
    const actual = c.req.header("authorization") ?? "";
    if (!expected) return c.json({ detail: "Meeting bot authorization is not configured" }, 503);
    if (!timingSafeEqualString(actual, `Bearer ${expected}`)) return c.json({ detail: "Unauthorized" }, 401);
    await next();
  });

  app.post("/v1/bots", async (c) => {
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_CREATE_BOT_BODY_BYTES) return c.json({ detail: "Request body is too large" }, 413);
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ detail: "Request body must be valid JSON" }, 400);
    }
    const parsed = createBotSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ detail: "Invalid bot creation request", issues: parsed.error.issues }, 400);
    }
    // Validate the meeting URL before any browser work: a non-Teams URL must
    // never cause a Chromium launch.
    const normalizedMeetingUrl = normalizeTeamsJoinUrl(parsed.data.meetingUrl);
    if (!normalizedMeetingUrl) {
      return c.json({ detail: "Meeting URL must be a supported Microsoft Teams join URL", failureStage: "invalid_meeting_url" }, 422);
    }
    const input: CreateBotInput = { ...parsed.data, meetingUrl: normalizedMeetingUrl };
    const webhookOriginError = validateWebhookOrigin(input.webhook.url, deps.env.BOT_WEBHOOK_ALLOWED_ORIGINS);
    if (webhookOriginError) return c.json({ detail: webhookOriginError }, 400);
    const duplicate = [...sessions.values()].find(
      (session) => session.botSessionId === input.botSessionId && !isTerminalBotSessionState(session.state)
    );
    if (duplicate) {
      return c.json({ detail: `A live session already exists for botSessionId ${input.botSessionId}`, runtimeBotId: duplicate.runtimeBotId }, 409);
    }
    if (liveSessionCount(sessions) >= maxConcurrentSessions(deps.env)) {
      return c.json({ detail: "Meeting bot runtime is at capacity" }, 429);
    }

    const runtimeBotId = deps.randomUUID?.() ?? crypto.randomUUID();
    const createdAt = nowIso(deps);
    const session: SessionRecord = {
      runtimeBotId,
      botSessionId: input.botSessionId,
      occurrenceId: input.occurrenceId,
      state: "created",
      stateHistory: [{ state: "created", at: createdAt }],
      createdAt,
      lastHeartbeatAt: createdAt,
      diagnosticsKeys: [],
      logEntries: [],
      webhookSeq: 0
    };
    sessions.set(runtimeBotId, session);
    const control = new AbortController();
    controls.set(runtimeBotId, control);
    // The trailing catch is load-bearing: an unhandled rejection here would
    // crash the Node process and kill every other in-flight recording.
    void runBotLifecycle({ deps, session, input }, control)
      .catch((error) => console.error(`bot ${runtimeBotId} lifecycle failed`, error))
      .finally(() => controls.delete(runtimeBotId));
    return c.json({ runtimeBotId, state: "created" }, 201);
  });

  app.get("/v1/bots/:runtimeBotId", (c) => {
    const session = sessions.get(c.req.param("runtimeBotId"));
    if (!session) return c.json({ detail: "Not found" }, 404);
    return c.json(publicStatus(session));
  });

  app.post("/v1/bots/:runtimeBotId/cancel", (c) => {
    const session = sessions.get(c.req.param("runtimeBotId"));
    if (!session) return c.json({ detail: "Not found" }, 404);
    if (!isTerminalBotSessionState(session.state)) {
      // Abort before anything else: a hung webhook or upload endpoint must
      // not keep the bot recording after an explicit cancel.
      controls.get(session.runtimeBotId)?.abort("canceled");
    }
    return c.json({ runtimeBotId: session.runtimeBotId, botSessionId: session.botSessionId, state: session.state }, 202);
  });

  app.get("/v1/bots/:runtimeBotId/diagnostics", (c) => {
    const session = sessions.get(c.req.param("runtimeBotId"));
    if (!session) return c.json({ detail: "Not found" }, 404);
    return c.json({
      state: session.state,
      stateHistory: session.stateHistory,
      ...(session.failureStage ? { failureStage: session.failureStage } : {}),
      ...(session.failureReason ? { failureReason: session.failureReason } : {}),
      logTail: session.logEntries.slice(-LOG_TAIL_LIMIT),
      uploadedDiagnostics: session.diagnosticsKeys
    });
  });

  return app;
}

async function runBotLifecycle(ctx: SessionContext, control: AbortController): Promise<void> {
  const { deps, session, input } = ctx;
  const heartbeat = startHeartbeat(ctx);
  try {
    // Emit the initial state so the webhook stream is a complete history.
    await emitStateWebhook(ctx);
    let result: RecordingResult | null = null;
    let recordError: unknown = null;
    try {
      result = await deps.recorder.record({
        meetingUrl: input.meetingUrl,
        displayName: input.displayName,
        joinTimeoutSeconds: input.joinTimeoutSeconds,
        maxDurationSeconds: input.maxDurationSeconds,
        allowGuestJoin: deps.env.BOT_ALLOW_GUEST_JOIN !== "false",
        abortSignal: control.signal,
        onState: async (state) => {
          if (control.signal.aborted || isTerminalBotSessionState(session.state) || session.state === state) return;
          if (state === "recording" && !session.startedAt) session.startedAt = nowIso(deps);
          await transition(ctx, state);
        },
        onLog: async (log) => {
          appendLog(ctx, log);
        }
      });
    } catch (error) {
      recordError = error;
    }

    if (control.signal.aborted) {
      await finishCanceled(ctx, result);
      return;
    }
    if (recordError) throw recordError;
    await finishCompleted(ctx, result ?? { bytes: new Uint8Array(), contentType: "audio/mpeg" });
  } catch (error) {
    await finishFailed(ctx, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function finishCompleted(ctx: SessionContext, result: RecordingResult): Promise<void> {
  const { deps, session, input } = ctx;
  await transition(ctx, "stopping");
  session.recordingKey = input.upload.recordingKey;
  await transition(ctx, "uploading");
  appendLog(ctx, { level: "info", message: "Uploading recording", details: { recordingKey: input.upload.recordingKey, sizeBytes: result.bytes.byteLength } });
  await uploadWithRetry(deps, { url: input.upload.url, token: input.upload.token, key: input.upload.recordingKey, bytes: result.bytes, contentType: result.contentType });
  const threshold = input.upload.chunkThresholdBytes ?? DEFAULT_CHUNK_THRESHOLD_BYTES;
  if (input.upload.chunkKeyPrefix && result.bytes.byteLength > threshold) {
    const chunks = await splitForUpload(ctx, result.bytes);
    const chunkKeys: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const key = `${input.upload.chunkKeyPrefix}chunk-${String(index).padStart(3, "0")}.mp3`;
      await uploadWithRetry(deps, { url: input.upload.url, token: input.upload.token, key, bytes: chunk, contentType: result.contentType });
      chunkKeys.push(key);
    }
    session.recordingChunkKeys = chunkKeys;
    appendLog(ctx, { level: "info", message: "Uploaded recording chunks", details: { count: chunkKeys.length } });
  }
  appendLog(ctx, { level: "info", message: "Recording uploaded", details: { sizeBytes: result.bytes.byteLength } });
  await transition(ctx, "post_processing_completed");
}

async function splitForUpload(ctx: SessionContext, bytes: Uint8Array): Promise<Uint8Array[]> {
  try {
    return await ctx.deps.splitRecording({ bytes, chunkSeconds: CHUNK_SECONDS });
  } catch (error) {
    throw new BotRecorderError(`Recording chunking failed: ${redactSensitiveText(errorMessage(error))}`, "upload", false);
  }
}

async function finishCanceled(ctx: SessionContext, result: RecordingResult | null): Promise<void> {
  const { deps, session, input } = ctx;
  if (isTerminalBotSessionState(session.state)) return;
  appendLog(ctx, { level: "info", message: "Meeting bot run canceled", details: { state: session.state } });
  await transition(ctx, "stopping");
  if (result && result.bytes.byteLength > 0) {
    session.recordingKey = input.upload.recordingKey;
    await transition(ctx, "uploading");
    try {
      await uploadWithRetry(deps, {
        url: input.upload.url,
        token: input.upload.token,
        key: input.upload.recordingKey,
        bytes: result.bytes,
        contentType: result.contentType
      });
    } catch (error) {
      // Cancellation wins: a failed partial upload must still end as canceled.
      session.recordingKey = undefined;
      appendLog(ctx, { level: "error", message: "Partial recording upload failed after cancel", details: { error: redactSensitiveText(errorMessage(error)) } });
    }
  }
  await transition(ctx, "canceled");
}

async function finishFailed(ctx: SessionContext, error: unknown): Promise<void> {
  const { session } = ctx;
  if (isTerminalBotSessionState(session.state)) return;
  const stage: BotFailureStage = error instanceof BotRecorderError ? error.stage : "internal";
  const reason = redactSensitiveText(errorMessage(error));
  session.failureStage = stage;
  session.failureReason = reason;
  appendLog(ctx, { level: "error", message: "Meeting bot lifecycle failed", details: { failureStage: stage, error: reason } });
  // Diagnostics were captured by the recorder before its cleanup ran; upload
  // them before emitting the terminal webhook so diagnosticsKeys are exact.
  const diagnostics = error instanceof BotRecorderError ? error.diagnostics : undefined;
  session.diagnosticsKeys = await uploadDiagnostics(ctx, diagnostics);
  await transition(ctx, "failed");
}

/**
 * Uploads failure diagnostics one by one; failures here are logged but never
 * thrown so they cannot mask the original failure. Returns uploaded keys.
 */
async function uploadDiagnostics(ctx: SessionContext, diagnostics: RecorderDiagnostics | undefined): Promise<string[]> {
  const { deps, session, input } = ctx;
  const prefix = `diagnostics/${session.botSessionId}/`;
  const encoder = new TextEncoder();
  const artifacts: Array<{ key: string; bytes: Uint8Array; contentType: string }> = [];
  if (diagnostics?.screenshotPng && diagnostics.screenshotPng.byteLength > 0) {
    artifacts.push({ key: `${prefix}screenshot.png`, bytes: diagnostics.screenshotPng, contentType: "image/png" });
  }
  if (diagnostics?.pageHtml) {
    artifacts.push({ key: `${prefix}page.html`, bytes: encoder.encode(sanitizePageHtml(diagnostics.pageHtml)), contentType: "text/html" });
  }
  if (diagnostics?.consoleLines && diagnostics.consoleLines.length > 0) {
    artifacts.push({
      key: `${prefix}console.log`,
      bytes: encoder.encode(diagnostics.consoleLines.map(redactSensitiveText).join("\n")),
      contentType: "text/plain"
    });
  }
  if (session.logEntries.length > 0) {
    artifacts.push({ key: `${prefix}bot.log`, bytes: encoder.encode(session.logEntries.join("\n")), contentType: "text/plain" });
  }
  if (diagnostics?.visibleText) {
    artifacts.push({ key: `${prefix}visible-text.txt`, bytes: encoder.encode(redactSensitiveText(diagnostics.visibleText)), contentType: "text/plain" });
  }
  const uploaded: string[] = [];
  for (const artifact of artifacts) {
    try {
      await deps.uploadArtifact({ url: input.upload.url, token: input.upload.token, ...artifact });
      uploaded.push(artifact.key);
    } catch (error) {
      console.error(`bot ${session.runtimeBotId} failed to upload diagnostic ${artifact.key}`, redactSensitiveText(errorMessage(error)));
    }
  }
  return uploaded;
}

async function uploadWithRetry(
  deps: BotRuntimeDeps,
  input: { url: string; token: string; key: string; bytes: Uint8Array; contentType: string }
): Promise<void> {
  // The bytes are already buffered in memory, so retrying a transient upload
  // failure is cheap — and a single failed attempt would lose the entire
  // meeting's audio.
  const retryDelayMs = positiveNumberOr(deps.env.BOT_UPLOAD_RETRY_DELAY_MS, DEFAULT_UPLOAD_RETRY_DELAY_MS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await deps.uploadArtifact(input);
      return;
    } catch (error) {
      lastError = error;
      // Client errors will not succeed on retry.
      if (error instanceof UploadHttpError && error.status >= 400 && error.status < 500) break;
      if (attempt < UPLOAD_ATTEMPTS) await sleep(retryDelayMs * attempt);
    }
  }
  throw new BotRecorderError(`Recording upload failed: ${redactSensitiveText(errorMessage(lastError))}`, "upload", false);
}

async function transition(ctx: SessionContext, state: BotSessionState): Promise<void> {
  const { deps, session } = ctx;
  session.state = state;
  session.stateHistory.push({ state, at: nowIso(deps) });
  if (isTerminalBotSessionState(state) && !session.stoppedAt) session.stoppedAt = nowIso(deps);
  await emitStateWebhook(ctx);
}

async function emitStateWebhook(ctx: SessionContext): Promise<void> {
  await deliverWebhook(ctx, buildWebhookPayload(ctx, "state_change"));
}

function startHeartbeat(ctx: SessionContext): ReturnType<typeof setInterval> {
  const { deps, session } = ctx;
  const seconds = positiveNumberOr(deps.env.BOT_HEARTBEAT_SECONDS, DEFAULT_HEARTBEAT_SECONDS);
  const timer = setInterval(() => {
    if (isTerminalBotSessionState(session.state)) return;
    session.lastHeartbeatAt = nowIso(deps);
    void deliverWebhook(ctx, buildWebhookPayload(ctx, "heartbeat")).catch(() => undefined);
  }, seconds * 1_000);
  // Keep the heartbeat from holding the process open after server shutdown.
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function buildWebhookPayload(ctx: SessionContext, eventType: "state_change" | "heartbeat" | "log"): string {
  const { deps, session } = ctx;
  session.webhookSeq += 1;
  return JSON.stringify({
    idempotencyKey: `${session.botSessionId}:${eventType}:${session.state}:${session.webhookSeq}`,
    botSessionId: session.botSessionId,
    runtimeBotId: session.runtimeBotId,
    eventType,
    state: session.state,
    ...(session.failureStage ? { failureStage: session.failureStage } : {}),
    ...(session.failureReason ? { failureReason: session.failureReason } : {}),
    ...(session.recordingKey ? { recordingKey: session.recordingKey } : {}),
    ...(session.recordingChunkKeys ? { recordingChunkKeys: session.recordingChunkKeys } : {}),
    ...(session.diagnosticsKeys.length > 0 ? { diagnosticsKeys: session.diagnosticsKeys } : {}),
    timestamp: nowIso(deps)
  });
}

async function deliverWebhook(ctx: SessionContext, body: string): Promise<void> {
  const { deps, session, input } = ctx;
  const retryDelayMs = positiveNumberOr(deps.env.BOT_WEBHOOK_RETRY_DELAY_MS, DEFAULT_WEBHOOK_RETRY_DELAY_MS);
  // Webhook delivery is retried but never throws: a failing control-plane
  // endpoint must not abort a healthy recording (and a throw out of a catch
  // block would crash the whole runtime process).
  for (let attempt = 1; attempt <= WEBHOOK_DELIVERY_ATTEMPTS; attempt += 1) {
    try {
      await deps.sendWebhook({ url: input.webhook.url, token: input.webhook.token, body });
      return;
    } catch (error) {
      if (attempt === WEBHOOK_DELIVERY_ATTEMPTS) {
        console.error(`bot ${session.runtimeBotId} failed to deliver webhook after ${attempt} attempts`, redactSensitiveText(errorMessage(error)));
        return;
      }
      await sleep(retryDelayMs * attempt);
    }
  }
}

function appendLog(ctx: SessionContext, log: BotRuntimeLog): void {
  const { deps, session } = ctx;
  const line = redactSensitiveText(
    JSON.stringify({ timestamp: nowIso(deps), level: log.level, message: log.message, state: session.state, details: log.details ?? {} })
  );
  session.logEntries.push(line);
  if (session.logEntries.length > LOG_TAIL_LIMIT) session.logEntries.splice(0, session.logEntries.length - LOG_TAIL_LIMIT);
}

async function computeHealthChecks(deps: BotRuntimeDeps): Promise<HealthChecks> {
  const [chromium, ffmpeg, pulseaudio, tempWritable] = await Promise.all([
    deps.checkBinary("chromium"),
    deps.checkBinary("ffmpeg"),
    deps.checkBinary("pulseaudio"),
    deps.checkTempWritable()
  ]);
  const configIssues: string[] = [];
  if (!deps.env.BOT_INTERNAL_TOKEN) configIssues.push("BOT_INTERNAL_TOKEN is not set");
  if (deps.env.BOT_ALLOW_GUEST_JOIN === "false") configIssues.push("BOT_ALLOW_GUEST_JOIN is disabled");
  return {
    chromium: binaryCheck(chromium, "chromium"),
    ffmpeg: binaryCheck(ffmpeg, "ffmpeg"),
    pulseaudio: binaryCheck(pulseaudio, "pulseaudio"),
    tempWritable: tempWritable ? { ok: true } : { ok: false, detail: "temp directory is not writable" },
    config: configIssues.length === 0 ? { ok: true } : { ok: false, detail: configIssues.join("; ") }
  };
}

function binaryCheck(ok: boolean, name: string): HealthCheck {
  return ok ? { ok: true } : { ok: false, detail: `${name} is not available` };
}

function liveSessionCount(sessions: Map<string, SessionRecord>): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (!isTerminalBotSessionState(session.state)) count += 1;
  }
  return count;
}

function maxConcurrentSessions(env: RuntimeEnv): number {
  const parsed = Number(env.BOT_MAX_CONCURRENT_SESSIONS);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_MAX_CONCURRENT_SESSIONS;
}

function validateWebhookOrigin(webhookUrl: string, allowedOrigins: string | undefined): string | null {
  const allowed = (allowedOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (allowed.length === 0) return null;
  let origin: string;
  try {
    origin = new URL(webhookUrl).origin;
  } catch {
    return "Webhook URL is invalid";
  }
  if (!allowed.includes(origin)) return `Webhook origin ${origin} is not allowed`;
  return null;
}

function publicStatus(session: SessionRecord) {
  return {
    runtimeBotId: session.runtimeBotId,
    botSessionId: session.botSessionId,
    state: session.state,
    createdAt: session.createdAt,
    ...(session.startedAt ? { startedAt: session.startedAt } : {}),
    ...(session.stoppedAt ? { stoppedAt: session.stoppedAt } : {}),
    lastHeartbeatAt: session.lastHeartbeatAt,
    ...(session.failureStage ? { failureStage: session.failureStage } : {}),
    ...(session.failureReason ? { failureReason: session.failureReason } : {})
  };
}

/**
 * Scrubs bearer tokens and signed-URL query credentials. Applied to every
 * stored log line, failure reason, and uploaded diagnostic so the webhook
 * and upload tokens can never leak through observability artifacts.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer [^\s"]+/g, "Bearer [redacted]")
    .replace(/([?&](?:sig|token|sas|key)=)[^&\s"]*/gi, "$1[redacted]");
}

/** Strips inline scripts and scrubs credentials from captured page HTML. */
export function sanitizePageHtml(html: string): string {
  return redactSensitiveText(html.replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, ""));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(deps: BotRuntimeDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function positiveNumberOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeVersion(env: RuntimeEnv): string {
  return env.BOT_RUNTIME_VERSION?.trim() || "unknown";
}
