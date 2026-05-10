import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRuntimeDeps } from "./app";

type RuntimeProcessEnv = Record<string, string | undefined>;
type RuntimeRecorderInput = Parameters<BotRuntimeDeps["recorder"]["record"]>[0];

export function createDefaultDeps(env: RuntimeProcessEnv): BotRuntimeDeps {
  return {
    env,
    checkBinary: async (name) => {
      if (name === "ffmpeg") return binaryAvailable("ffmpeg");
      if (env.CHROMIUM_EXECUTABLE_PATH) return binaryAvailable(env.CHROMIUM_EXECUTABLE_PATH);
      return playwrightChromiumAvailable();
    },
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
        const joinedState = input.serviceAccount
          ? await joinWithServiceAccount(page, input)
          : await joinAsGuest(page, input);
        await input.onState?.(joinedState);
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

async function joinWithServiceAccount(page: any, input: RuntimeRecorderInput): Promise<"waiting_room" | "joined"> {
  if (!input.serviceAccount) throw new Error("Service account credentials are missing");
  await clickTeamsWebEntry(page);
  await fillIfVisible(page.getByRole("textbox", { name: /email|phone|skype/i }), input.serviceAccount.email, 15_000);
  await clickIfVisible(page.getByRole("button", { name: /next/i }), 10_000);
  await fillIfVisible(page.getByRole("textbox", { name: /password/i }), input.serviceAccount.password, 15_000);
  await clickIfVisible(page.getByRole("button", { name: /sign in/i }), 10_000);
  await clickIfVisible(page.getByRole("button", { name: /yes|stay signed in/i }), 5_000);
  return joinFromPrejoin(page, input.botName);
}

async function joinAsGuest(page: any, input: RuntimeRecorderInput): Promise<"waiting_room" | "joined"> {
  if (!input.allowGuestJoin) throw new Error("Guest join is disabled and no service account credentials are configured");
  await clickTeamsWebEntry(page);
  await fillGuestName(page, input.botName);
  return joinFromPrejoin(page, input.botName);
}

async function clickTeamsWebEntry(page: any): Promise<void> {
  const clicked = await clickAny(
    [
      page.getByRole("button", { name: /continue on this browser|join on the web|use the web app|continue without audio or video/i }),
      page.getByRole("link", { name: /continue on this browser|join on the web|use the web app/i }),
      page.getByText(/continue on this browser|join on the web|use the web app/i)
    ],
    20_000
  );
  if (!clicked) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
}

async function fillGuestName(page: any, botName: string): Promise<void> {
  await fillAny(guestNameLocators(page), botName, 20_000);
}

async function joinFromPrejoin(page: any, botName: string): Promise<"waiting_room" | "joined"> {
  await dismissDevicePrompts(page);
  await fillAny(guestNameLocators(page), botName, 1_000);
  const clickedJoin = await clickAny(
    [
      page.getByRole("button", { name: /^join now$/i }),
      page.getByRole("button", { name: /^join$/i }),
      page.getByText(/^join now$/i)
    ],
    30_000
  );
  if (!clickedJoin) throw new Error("Teams pre-join screen did not show a Join now button");
  return waitForJoinedOrLobby(page);
}

function guestNameLocators(page: any): any[] {
  const selectors = [
    'input[data-tid="prejoin-display-name-input"]',
    'input[data-tid*="display-name" i]',
    'input[data-tid*="username" i]',
    'input[id*="displayName" i]',
    'input[id*="display-name" i]',
    'input[name*="displayName" i]',
    'input[name*="display-name" i]',
    'input[aria-label*="name" i]',
    'input[placeholder*="name" i]',
    '[contenteditable="true"][role="textbox"]'
  ];
  return locatorScopes(page).flatMap((scope) => [
    scope.getByRole("textbox", { name: /type your name|enter name|name/i }),
    scope.getByPlaceholder(/type your name|enter name|name/i),
    ...selectors.map((selector) => scope.locator(selector))
  ]);
}

function locatorScopes(page: any): any[] {
  const scopes = [page];
  const frames = typeof page.frames === "function" ? page.frames() : [];
  for (const frame of frames) {
    if (frame && frame !== page && typeof frame.locator === "function") scopes.push(frame);
  }
  return scopes;
}

async function dismissDevicePrompts(page: any): Promise<void> {
  await clickIfVisible(page.getByRole("button", { name: /continue without audio or video/i }), 3_000);
  for (const label of [/microphone/i, /camera/i]) {
    const toggle = page.getByRole("switch", { name: label });
    const checked = await toggle.isChecked({ timeout: 1_000 }).catch(() => false);
    if (checked) await toggle.click({ timeout: 1_000 }).catch(() => undefined);
  }
}

async function waitForJoinedOrLobby(page: any): Promise<"waiting_room" | "joined"> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await hasJoinedSignals(page, 1_000)) return "joined";
    if (await hasLobbySignals(page, 1_000)) return "waiting_room";
    await page.waitForTimeout(1_000);
  }
  throw new Error("Teams did not confirm joined or waiting room state after Join now");
}

async function hasJoinedSignals(page: any, timeout: number): Promise<boolean> {
  return (
    (await page.getByRole("button", { name: /leave|hang up/i }).isVisible({ timeout }).catch(() => false)) ||
    (await page.getByRole("button", { name: /people|participants|chat/i }).isVisible({ timeout }).catch(() => false)) ||
    (await page.getByText(/you(?:'|’)re the only one here|meeting chat|participants/i).isVisible({ timeout }).catch(() => false))
  );
}

async function hasLobbySignals(page: any, timeout: number): Promise<boolean> {
  return (
    (await page.getByText(/someone.*let you in|waiting.*lobby|you(?:'|’)re in the lobby|when the meeting starts/i).isVisible({ timeout }).catch(() => false)) ||
    (await page.getByText(/ask to join|admit/i).isVisible({ timeout }).catch(() => false))
  );
}

async function clickAny(locators: any[], timeout: number): Promise<boolean> {
  for (const locator of locators) {
    if (await clickIfVisible(locator, timeout)) return true;
  }
  return false;
}

async function fillAny(locators: any[], value: string, timeout: number): Promise<boolean> {
  for (const locator of locators) {
    if (await fillIfVisible(locator, value, timeout)) return true;
  }
  return false;
}

async function clickIfVisible(locator: any, timeout: number): Promise<boolean> {
  if (!(await locator.first().isVisible({ timeout }).catch(() => false))) return false;
  await locator.first().click({ timeout });
  return true;
}

async function fillIfVisible(locator: any, value: string, timeout: number): Promise<boolean> {
  if (!(await locator.first().isVisible({ timeout }).catch(() => false))) return false;
  await locator.first().fill(value, { timeout });
  return true;
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

async function playwrightChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await loadPlaywrightChromium();
    return binaryAvailable(browser.executablePath());
  } catch {
    return false;
  }
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

export const __runtimeTest = {
  fillGuestName,
  joinAsGuest
};
