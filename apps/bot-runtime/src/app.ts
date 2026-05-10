import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqualString } from "@minutesbot/shared";

type RuntimeEnv = {
  BOT_INTERNAL_TOKEN?: string;
  BOT_RECORDING_BUCKET_NAME?: string;
  BOT_RUNTIME_VERSION?: string;
  BOT_CONTAINER_INSTANCE_ID?: string;
  TEAMS_RECORDER_EMAIL?: string;
  TEAMS_RECORDER_PASSWORD?: string;
  BOT_ALLOW_GUEST_JOIN?: string;
};

export type BotState = "queued" | "joining" | "waiting_room" | "joined" | "recording" | "post_processing" | "ended" | "failed";

type BotRecord = {
  id: string;
  meeting_url: string;
  state: BotState;
  transcription_state?: string;
  recording_state?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  latest_error?: string;
};

type RecordingResult = {
  bytes: Uint8Array;
  contentType: string;
  joinMode: "service_account" | "guest";
};

export type BotRuntimeDeps = {
  env: RuntimeEnv;
  checkBinary: (name: "chromium" | "ffmpeg") => Promise<boolean>;
  recorder: {
    record(input: {
      meetingUrl: string;
      botName: string;
      botImage?: { type: "image/png" | "image/jpeg"; data: string };
      serviceAccount?: { email: string; password: string };
      allowGuestJoin: boolean;
      onState?: (state: Extract<BotState, "waiting_room" | "joined">) => Promise<void>;
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
  meeting_url: z.string().trim().url(),
  bot_name: z.string().trim().min(1),
  bot_image: z.object({ type: z.enum(["image/png", "image/jpeg"]), data: z.string() }).optional(),
  recording_settings: z.object({ format: z.enum(["mp3", "mp4", "webm"]).default("mp3") }).optional(),
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

  app.get("/_ops/health", async (c) => {
    const missing = await missingRuntimeSettings(deps);
    return c.json(
      {
        ok: missing.length === 0,
        runtime: "meeting-bot-container",
        missing,
        auth: deps.env.TEAMS_RECORDER_EMAIL && deps.env.TEAMS_RECORDER_PASSWORD ? "service_account" : "guest",
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
    if (expected && !timingSafeEqualString(actual, `Bearer ${expected}`)) return c.json({ detail: "Unauthorized" }, 401);
    await next();
  });

  app.post("/api/v1/bots", async (c) => {
    const input = createBotSchema.parse(await c.req.json());
    const id = deps.randomUUID?.() ?? crypto.randomUUID();
    const bot: BotRecord = {
      id,
      meeting_url: input.meeting_url,
      state: "queued",
      recording_state: "pending",
      transcription_state: "pending",
      metadata: input.metadata,
      created_at: deps.now?.() ?? new Date().toISOString()
    };
    bots.set(id, bot);
    const created = publicBot(bot);
    void runBotLifecycle(deps, bot, input);
    return c.json(created, 201);
  });

  app.get("/api/v1/bots/:id", (c) => {
    const bot = bots.get(c.req.param("id"));
    if (!bot) return c.json({ detail: "Not found" }, 404);
    return c.json(publicBot(bot));
  });

  app.get("/api/v1/bots/:id/transcript", (c) => c.json([]));

  app.get("/api/v1/bots/:id/recording", (c) => c.json({ detail: "Recordings are uploaded directly to R2" }, 404));

  app.post("/api/v1/bots/:id/delete_data", (c) => {
    bots.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}

async function runBotLifecycle(deps: BotRuntimeDeps, bot: BotRecord, input: z.infer<typeof createBotSchema>): Promise<void> {
  try {
    await updateBot(deps, bot, input, { state: "joining" });
    const recording = await deps.recorder.record({
      meetingUrl: input.meeting_url,
      botName: input.bot_name,
      botImage: input.bot_image,
      serviceAccount:
        deps.env.TEAMS_RECORDER_EMAIL && deps.env.TEAMS_RECORDER_PASSWORD
          ? { email: deps.env.TEAMS_RECORDER_EMAIL, password: deps.env.TEAMS_RECORDER_PASSWORD }
          : undefined,
      allowGuestJoin: deps.env.BOT_ALLOW_GUEST_JOIN !== "false",
      onState: async (state) => {
        await updateBot(deps, bot, input, { state });
      }
    });
    await updateBot(deps, bot, input, { state: "recording", recording_state: "recording" });
    await deps.recordingStore.putRecording({
      bucketName: input.external_media_storage_settings?.bucket_name ?? deps.env.BOT_RECORDING_BUCKET_NAME ?? "",
      key: input.external_media_storage_settings?.recording_file_name ?? `recordings/${bot.id}/recording.mp3`,
      bytes: recording.bytes,
      contentType: recording.contentType
    });
    await updateBot(deps, bot, input, { state: "post_processing", recording_state: "complete" });
    await updateBot(deps, bot, input, { state: "ended", recording_state: "complete", transcription_state: "complete" }, "post_processing_completed");
  } catch (error) {
    bot.latest_error = error instanceof Error ? error.message : String(error);
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
  await Promise.all(
    input.webhooks
      .filter((webhook) => webhook.triggers.includes("bot.state_change"))
      .map((webhook) => deps.sendWebhook({ url: webhook.url, body, internalToken: deps.env.BOT_INTERNAL_TOKEN }))
  );
}

async function missingRuntimeSettings(deps: BotRuntimeDeps): Promise<string[]> {
  const missing: string[] = [];
  if (!deps.env.BOT_RECORDING_BUCKET_NAME) missing.push("BOT_RECORDING_BUCKET_NAME");
  if (!deps.env.TEAMS_RECORDER_PASSWORD && deps.env.BOT_ALLOW_GUEST_JOIN === "false") missing.push("TEAMS_RECORDER_PASSWORD");
  if (!(await deps.checkBinary("chromium"))) missing.push("chromium");
  if (!(await deps.checkBinary("ffmpeg"))) missing.push("ffmpeg");
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

function runtimeVersion(env: RuntimeEnv): string {
  return env.BOT_RUNTIME_VERSION?.trim() || "unknown";
}
