import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRuntimeDeps } from "./app";

type RuntimeProcessEnv = Record<string, string | undefined>;

export function createDefaultDeps(env: RuntimeProcessEnv): BotRuntimeDeps {
  return {
    env,
    checkBinary: async (name) => binaryAvailable(name === "chromium" ? env.CHROMIUM_EXECUTABLE_PATH || "chromium" : "ffmpeg"),
    recorder: createBrowserRecorder(env),
    recordingStore: createHttpRecordingStore(env),
    sendWebhook: async ({ url, body, internalToken }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(internalToken ? { authorization: `Bearer ${internalToken}` } : {}) },
        body
      });
      if (!response.ok) throw new Error(`Webhook ${url} returned ${response.status}`);
    }
  };
}

function createBrowserRecorder(env: RuntimeProcessEnv): BotRuntimeDeps["recorder"] {
  return {
    async record(input) {
      const fixturePath = env.BOT_RECORDING_FIXTURE_PATH;
      if (fixturePath) {
        return {
          bytes: new Uint8Array(await readFile(fixturePath)),
          contentType: contentTypeForFormat(env.BOT_RECORDING_FORMAT || "mp3"),
          joinMode: input.serviceAccount ? "service_account" : "guest"
        };
      }

      const browser = await loadPlaywrightChromium();
      const userDataDir = env.BOT_BROWSER_PROFILE_DIR || (await mkdtemp(join(tmpdir(), "minutesbot-profile-")));
      const context = await browser.launchPersistentContext(userDataDir, {
        headless: env.BOT_HEADLESS !== "false",
        executablePath: env.CHROMIUM_EXECUTABLE_PATH,
        args: ["--use-fake-ui-for-media-stream", "--no-sandbox", "--disable-dev-shm-usage"]
      });
      const page = await context.newPage();
      try {
        await page.goto(input.meetingUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs(env.BOT_JOIN_TIMEOUT_MS, 90_000) });
        if (input.serviceAccount) await tryServiceAccountLogin(page, input.serviceAccount.email, input.serviceAccount.password);
        await tryGuestJoin(page, input.botName);
        const bytes = await recordSilentAudio(env);
        return {
          bytes,
          contentType: contentTypeForFormat(env.BOT_RECORDING_FORMAT || "mp3"),
          joinMode: input.serviceAccount ? "service_account" : "guest"
        };
      } finally {
        await context.close().catch(() => undefined);
        if (!env.BOT_BROWSER_PROFILE_DIR) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

function createHttpRecordingStore(env: RuntimeProcessEnv): BotRuntimeDeps["recordingStore"] {
  return {
    async putRecording(input) {
      const uploadUrl = env.BOT_STORAGE_UPLOAD_URL;
      if (!uploadUrl) throw new Error("BOT_STORAGE_UPLOAD_URL is not configured");
      const body = new ArrayBuffer(input.bytes.byteLength);
      new Uint8Array(body).set(input.bytes);
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          ...(env.BOT_INTERNAL_TOKEN ? { authorization: `Bearer ${env.BOT_INTERNAL_TOKEN}` } : {}),
          "content-type": input.contentType,
          "x-recording-bucket": input.bucketName,
          "x-recording-key": input.key
        },
        body
      });
      if (!response.ok) throw new Error(`Recording upload failed with ${response.status}`);
    }
  };
}

async function loadPlaywrightChromium(): Promise<any> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const playwright = await importer("playwright");
  return playwright.chromium;
}

async function tryServiceAccountLogin(page: any, email: string, password: string): Promise<void> {
  await page.getByRole("textbox", { name: /email|phone|skype/i }).fill(email).catch(() => undefined);
  await page.getByRole("button", { name: /next/i }).click().catch(() => undefined);
  await page.getByRole("textbox", { name: /password/i }).fill(password).catch(() => undefined);
  await page.getByRole("button", { name: /sign in/i }).click().catch(() => undefined);
  await page.getByRole("button", { name: /yes|stay signed in/i }).click({ timeout: 5_000 }).catch(() => undefined);
}

async function tryGuestJoin(page: any, botName: string): Promise<void> {
  await page.getByText(/continue on this browser|join on the web/i).click({ timeout: 15_000 }).catch(() => undefined);
  await page.getByPlaceholder(/type your name|enter name/i).fill(botName).catch(() => undefined);
  await page.getByRole("button", { name: /join now|join/i }).click({ timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(5_000);
}

async function recordSilentAudio(env: RuntimeProcessEnv): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "minutesbot-recording-"));
  const file = join(dir, "recording.mp3");
  const seconds = Math.max(1, Number(env.BOT_RECORDING_SECONDS ?? "30"));
  await runFfmpeg(["-y", "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=16000", "-t", String(seconds), "-q:a", "9", "-acodec", "libmp3lame", file]);
  const bytes = new Uint8Array(await readFile(file));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

function binaryAvailable(name: string): boolean {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0 || spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}

function contentTypeForFormat(format: string): string {
  if (format === "webm") return "audio/webm";
  if (format === "mp4") return "audio/mp4";
  return "audio/mpeg";
}

function timeoutMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
