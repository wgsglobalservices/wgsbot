import { Hono } from "hono";
import { z } from "zod";
import { normalizeTeamsJoinUrl } from "@minutesbot/invite-parser";
import { timingSafeEqualString } from "@minutesbot/shared";

type RuntimeEnv = {
  BOT_INTERNAL_TOKEN?: string;
  BOT_RECORDING_BUCKET_NAME?: string;
  BOT_RUNTIME_VERSION?: string;
  BOT_CONTAINER_INSTANCE_ID?: string;
  BOT_ALLOW_GUEST_JOIN?: string;
  /**
   * Comma-separated list of origins webhooks may target. When set, createBot
   * rejects webhook URLs outside this list so a caller cannot point the
   * runtime (and its bearer token) at an attacker-controlled endpoint.
   */
  BOT_WEBHOOK_ALLOWED_ORIGINS?: string;
};

const WEBHOOK_DELIVERY_ATTEMPTS = 3;
const WEBHOOK_RETRY_DELAY_MS = 2_000;

const MAX_CREATE_BOT_BODY_BYTES = 5 * 1024 * 1024;

export type BotState = "queued" | "prejoin" | "joining" | "waiting_room" | "joined" | "recording" | "cancelling" | "cancelled" | "post_processing" | "ended" | "failed";

type BotRecord = {
  id: string;
  meeting_url: string;
  state: BotState;
  transcription_state?: string;
  recording_state?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  latest_error?: string;
  log_sequence: number;
};

type BotControl = {
  abortController: AbortController;
  input: z.infer<typeof createBotSchema>;
};

type BotRuntimeLog = {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
};

type RecordingResult = {
  bytes: Uint8Array;
  contentType: string;
  joinMode: "guest";
};

export type BotRuntimeDeps = {
  env: RuntimeEnv;
  checkBinary: (name: "chromium" | "ffmpeg" | "pulseaudio") => Promise<boolean>;
  recorder: {
    record(input: {
      meetingUrl: string;
      botName: string;
      botImage?: { type: "image/png" | "image/jpeg"; data: string };
      allowGuestJoin: boolean;
      joinTimeoutSeconds?: number;
      abortSignal?: AbortSignal;
      onState?: (state: Extract<BotState, "prejoin" | "waiting_room" | "joined" | "recording">) => Promise<void>;
      onLog?: (log: BotRuntimeLog) => Promise<void>;
    }): Promise<RecordingResult>;
  };
  recordingStore: {
    putRecording(input: { bucketName: string; key: string; bytes: Uint8Array; contentType: string }): Promise<void>;
  };
  sendWebhook: (input: { url: string; body: string; internalToken?: string }) => Promise<void>;
  randomUUID?: () => string;
  now?: () => string;
};

const createBotSchema = z.object({
  meeting_url: z.string().trim().url().transform((value, ctx) => {
    const normalized = normalizeTeamsJoinUrl(value);
    if (!normalized) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Meeting URL must be a supported Microsoft Teams join URL." });
      return z.NEVER;
    }
    return normalized;
  }),
  bot_name: z.string().trim().min(1),
  bot_image: z.object({ type: z.enum(["image/png", "image/jpeg"]), data: z.string() }).optional(),
  recording_settings: z.object({ format: z.enum(["mp3", "mp4", "webm"]).default("mp3") }).optional(),
  join_timeout_seconds: z.number().int().min(1).max(24 * 60 * 60).optional(),
  external_media_storage_settings: z
    .object({
      bucket_name: z.string().trim().min(1),
      recording_file_name: z.string().trim().min(1).optional()
    })
    .optional(),
  webhooks: z.array(z.object({ url: z.string().trim().url(), triggers: z.array(z.string()) })).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({})
});

export function createBotRuntimeApp(deps: BotRuntimeDeps): Hono {
  const app = new Hono();
  const bots = new Map<string, BotRecord>();
  const controls = new Map<string, BotControl>();
  // Binary availability cannot change within a container's lifetime; caching
  // keeps the unauthenticated health endpoint from spawning processes (and
  // blocking the event loop shared with live recordings) on every request.
  let missingSettingsCache: Promise<string[]> | null = null;

  app.get("/_ops/health", async (c) => {
    missingSettingsCache ??= missingRuntimeSettings(deps);
    const missing = await missingSettingsCache;
    return c.json(
      {
        ok: missing.length === 0,
        runtime: "meeting-bot-container",
        missing,
        auth: "guest",
        version: runtimeVersion(deps.env),
        diagnosticVersion: runtimeVersion(deps.env),
        containerInstanceId: deps.env.BOT_CONTAINER_INSTANCE_ID?.trim() || "unknown"
      },
      missing.length === 0 ? 200 : 503
    );
  });

  app.use("/api/*", async (c, next) => {
    const expected = deps.env.BOT_INTERNAL_TOKEN;
    const actual = c.req.header("authorization") ?? "";
    if (!expected) return c.json({ detail: "Meeting bot authorization is not configured" }, 503);
    if (!timingSafeEqualString(actual, `Bearer ${expected}`)) return c.json({ detail: "Unauthorized" }, 401);
    await next();
  });

  app.post("/api/v1/bots", async (c) => {
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
    const input = parsed.data;
    const webhookOriginError = validateWebhookOrigins(input.webhooks, deps.env.BOT_WEBHOOK_ALLOWED_ORIGINS);
    if (webhookOriginError) return c.json({ detail: webhookOriginError }, 400);
    const id = deps.randomUUID?.() ?? crypto.randomUUID();
    const bot: BotRecord = {
      id,
      meeting_url: input.meeting_url,
      state: "queued",
      recording_state: "pending",
      transcription_state: "pending",
      metadata: input.metadata,
      created_at: deps.now?.() ?? new Date().toISOString(),
      log_sequence: 0
    };
    bots.set(id, bot);
    const created = publicBot(bot);
    const control = { abortController: new AbortController(), input };
    controls.set(id, control);
    // The trailing catch is load-bearing: an unhandled rejection here would
    // crash the Node process and kill every other in-flight recording.
    void runBotLifecycle(deps, bot, input, control)
      .catch((error) => console.error(`bot ${id} lifecycle failed`, error))
      .finally(() => controls.delete(id));
    return c.json(created, 201);
  });

  app.get("/api/v1/bots/:id", (c) => {
    const bot = bots.get(c.req.param("id"));
    if (!bot) return c.json({ detail: "Not found" }, 404);
    return c.json(publicBot(bot));
  });

  app.get("/api/v1/bots/:id/transcript", (c) => c.json([]));

  app.get("/api/v1/bots/:id/recording", (c) => c.json({ detail: "Recordings are uploaded directly to R2" }, 404));

  app.post("/api/v1/bots/:id/cancel", async (c) => {
    const bot = bots.get(c.req.param("id"));
    if (!bot) return c.json({ detail: "Not found" }, 404);
    const control = controls.get(bot.id);
    if (isTerminalBotState(bot.state)) return c.json(publicBot(bot));
    // Abort before any webhook delivery: a hung or failing webhook endpoint
    // must not keep the bot recording after an explicit cancel.
    const wasCancelling = bot.state === "cancelling";
    bot.state = "cancelling";
    control?.abortController.abort("cancelled");
    if (!wasCancelling) {
      await emitStateWebhook(deps, control?.input ?? fallbackInput(bot), bot, "cancel_requested");
    }
    return c.json(publicBot(bot));
  });

  app.post("/api/v1/bots/:id/delete_data", (c) => {
    controls.get(c.req.param("id"))?.abortController.abort("deleted");
    controls.delete(c.req.param("id"));
    bots.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}

async function runBotLifecycle(deps: BotRuntimeDeps, bot: BotRecord, input: z.infer<typeof createBotSchema>, control: BotControl): Promise<void> {
  try {
    await updateBot(deps, bot, input, { state: "joining" });
    const recording = await deps.recorder.record({
      meetingUrl: input.meeting_url,
      botName: input.bot_name,
      botImage: input.bot_image,
      allowGuestJoin: deps.env.BOT_ALLOW_GUEST_JOIN !== "false",
      joinTimeoutSeconds: input.join_timeout_seconds,
      abortSignal: control.abortController.signal,
      onState: async (state) => {
        if (bot.state === "cancelling" || bot.state === "cancelled") return;
        await updateBot(deps, bot, input, { state, ...(state === "recording" ? { recording_state: "recording" } : {}) });
      },
      onLog: async (log) => {
        await emitBotLog(deps, input, bot, log);
      }
    });
    // delete_data removes the bot entirely: its partial recording must not
    // be uploaded and no further webhooks may reference the deleted id.
    if (control.abortController.signal.reason === "deleted") return;
    if (bot.state !== "recording" && bot.state !== "cancelling") {
      await emitBotLog(deps, input, bot, { level: "info", message: "Teams joined; starting recording", details: { state: bot.state } });
      await updateBot(deps, bot, input, { state: "recording", recording_state: "recording" });
    }
    await emitBotLog(deps, input, bot, { level: "info", message: "Uploading recording to R2", details: { recordingKey: input.external_media_storage_settings?.recording_file_name ?? `recordings/${bot.id}/recording.mp3` } });
    await deps.recordingStore.putRecording({
      bucketName: input.external_media_storage_settings?.bucket_name ?? deps.env.BOT_RECORDING_BUCKET_NAME ?? "",
      key: input.external_media_storage_settings?.recording_file_name ?? `recordings/${bot.id}/recording.mp3`,
      bytes: recording.bytes,
      contentType: recording.contentType
    });
    await emitBotLog(deps, input, bot, { level: "info", message: "Recording uploaded", details: { contentType: recording.contentType, sizeBytes: recording.bytes.byteLength } });
    await updateBot(deps, bot, input, { state: "post_processing", recording_state: "complete" });
    await updateBot(deps, bot, input, { state: "ended", recording_state: "complete", transcription_state: "complete" }, "post_processing_completed");
  } catch (error) {
    if (control.abortController.signal.reason === "deleted") return;
    if (control.abortController.signal.aborted) {
      await emitBotLog(deps, input, bot, { level: "info", message: "Meeting bot run cancelled", details: { state: bot.state } });
      await updateBot(deps, bot, input, { state: "cancelled", recording_state: bot.recording_state === "recording" ? "cancelled" : bot.recording_state ?? "cancelled", transcription_state: bot.transcription_state ?? "failed" }, "cancelled");
      return;
    }
    bot.latest_error = error instanceof Error ? error.message : String(error);
    await emitBotLog(deps, input, bot, { level: "error", message: "Meeting bot lifecycle failed", details: { error: bot.latest_error } });
    await updateBot(deps, bot, input, { state: "failed", recording_state: "failed", transcription_state: "failed" }, "fatal_error");
  }
}

async function updateBot(
  deps: BotRuntimeDeps,
  bot: BotRecord,
  input: z.infer<typeof createBotSchema>,
  patch: Partial<BotRecord>,
  eventType = "state_change"
): Promise<void> {
  Object.assign(bot, patch);
  await emitStateWebhook(deps, input, bot, eventType);
}

async function emitStateWebhook(deps: BotRuntimeDeps, input: z.infer<typeof createBotSchema>, bot: BotRecord, eventType: string): Promise<void> {
  const payload = {
    idempotency_key: `${bot.id}-${eventType}-${bot.state}`,
    bot_id: bot.id,
    bot_metadata: input.metadata,
    trigger: "bot.state_change",
    data: {
      event_type: eventType,
      new_state: bot.state,
      transcription_state: bot.transcription_state,
      recording_state: bot.recording_state,
      latest_error: bot.latest_error
    }
  };
  const body = JSON.stringify(payload);
  // Webhook delivery is retried but never throws: a failing control-plane
  // endpoint must not abort a healthy recording (and a throw out of a catch
  // block would crash the whole runtime process).
  await Promise.all(
    input.webhooks
      .filter((webhook) => webhook.triggers.includes("bot.state_change"))
      .map((webhook) => deliverWebhookWithRetry(deps, { url: webhook.url, body, internalToken: deps.env.BOT_INTERNAL_TOKEN }, bot.id, eventType))
  );
}

async function deliverWebhookWithRetry(
  deps: BotRuntimeDeps,
  input: { url: string; body: string; internalToken?: string },
  botId: string,
  eventType: string
): Promise<void> {
  for (let attempt = 1; attempt <= WEBHOOK_DELIVERY_ATTEMPTS; attempt += 1) {
    try {
      await deps.sendWebhook(input);
      return;
    } catch (error) {
      if (attempt === WEBHOOK_DELIVERY_ATTEMPTS) {
        console.error(`bot ${botId} failed to deliver ${eventType} webhook after ${attempt} attempts`, error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, WEBHOOK_RETRY_DELAY_MS * attempt));
    }
  }
}

function validateWebhookOrigins(webhooks: Array<{ url: string }>, allowedOrigins: string | undefined): string | null {
  const allowed = (allowedOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (allowed.length === 0) return null;
  for (const webhook of webhooks) {
    let origin: string;
    try {
      origin = new URL(webhook.url).origin;
    } catch {
      return `Webhook URL is invalid: ${webhook.url}`;
    }
    if (!allowed.includes(origin)) {
      return `Webhook origin ${origin} is not allowed`;
    }
  }
  return null;
}

async function emitBotLog(deps: BotRuntimeDeps, input: z.infer<typeof createBotSchema>, bot: BotRecord, log: BotRuntimeLog): Promise<void> {
  bot.log_sequence += 1;
  const payload = {
    idempotency_key: `${bot.id}-log-${bot.log_sequence}`,
    bot_id: bot.id,
    bot_metadata: input.metadata,
    trigger: "bot_logs.update",
    data: {
      event_type: "runtime_log",
      level: log.level,
      message: log.message,
      state: bot.state,
      timestamp: deps.now?.() ?? new Date().toISOString(),
      details: log.details ?? {}
    }
  };
  const body = JSON.stringify(payload);
  await Promise.all(
    input.webhooks
      .filter((webhook) => webhook.triggers.includes("bot_logs.update"))
      .map((webhook) => deps.sendWebhook({ url: webhook.url, body, internalToken: deps.env.BOT_INTERNAL_TOKEN }).catch(() => undefined))
  );
}

async function missingRuntimeSettings(deps: BotRuntimeDeps): Promise<string[]> {
  const missing: string[] = [];
  if (!deps.env.BOT_RECORDING_BUCKET_NAME) missing.push("BOT_RECORDING_BUCKET_NAME");
  if (deps.env.BOT_ALLOW_GUEST_JOIN === "false") missing.push("BOT_ALLOW_GUEST_JOIN");
  if (!(await deps.checkBinary("chromium"))) missing.push("chromium");
  if (!(await deps.checkBinary("ffmpeg"))) missing.push("ffmpeg");
  if (!(await deps.checkBinary("pulseaudio"))) missing.push("pulseaudio");
  return missing;
}

function publicBot(bot: BotRecord) {
  return {
    id: bot.id,
    meeting_url: bot.meeting_url,
    state: bot.state,
    transcription_state: bot.transcription_state,
    recording_state: bot.recording_state,
    latest_error: bot.latest_error
  };
}

function isTerminalBotState(state: BotState): boolean {
  return state === "ended" || state === "failed" || state === "cancelled";
}

function fallbackInput(bot: BotRecord): z.infer<typeof createBotSchema> {
  return {
    meeting_url: bot.meeting_url,
    bot_name: "minutesbot",
    webhooks: [],
    metadata: bot.metadata ?? {}
  };
}

function runtimeVersion(env: RuntimeEnv): string {
  return env.BOT_RUNTIME_VERSION?.trim() || "unknown";
}
