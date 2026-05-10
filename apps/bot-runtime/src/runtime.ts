import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRuntimeDeps } from "./app";

type RuntimeProcessEnv = Record<string, string | undefined>;
type RuntimeRecorderInput = Parameters<BotRuntimeDeps["recorder"]["record"]>[0];
type JoinMode = "guest";
type JoinedState = "waiting_room" | "joined";
type JoinDeadline = {
  seconds: number;
  expiresAt: number;
};

type AudioIo = {
  mkdtemp: (prefix: string) => Promise<string>;
  readFile: (path: string) => Promise<Uint8Array>;
  rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  runCommand: (command: string, args: string[]) => Promise<string | void>;
};

const PREJOIN_MAX_ATTEMPTS = 60;
const MEETING_NOT_STARTED_MAX_ATTEMPTS = 2 * 60 * 60;
const PREJOIN_POLL_INTERVAL_MS = 1_000;
const CONTROL_PROBE_TIMEOUT_MS = 0;
const CONTROL_ACTION_TIMEOUT_MS = 1_000;
const DEFAULT_JOIN_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;

export function createDefaultDeps(env: RuntimeProcessEnv): BotRuntimeDeps {
  return {
    env,
    checkBinary: async (name) => {
      if (name === "ffmpeg") return binaryAvailable("ffmpeg");
      if (name === "pulseaudio") return binaryAvailable("pulseaudio") && binaryAvailable("pactl");
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
          joinMode: "guest"
        };
      }

      const joinDeadline = createJoinDeadline(input.joinTimeoutSeconds);
      const audio = await withJoinDeadline(startPulseAudioSink(env), joinDeadline);
      const userDataDir = env.BOT_BROWSER_PROFILE_DIR || (await mkdtemp(join(tmpdir(), "minutesbot-profile-")));
      let context: any;
      try {
        const browser = await withJoinDeadline(loadPlaywrightChromium(), joinDeadline);
        context = await withJoinDeadline(
          browser.launchPersistentContext(userDataDir, {
            headless: env.BOT_HEADLESS !== "false",
            executablePath: env.CHROMIUM_EXECUTABLE_PATH,
            env: { ...process.env, PULSE_SINK: audio.sinkName },
            args: ["--use-fake-ui-for-media-stream", "--no-sandbox", "--disable-dev-shm-usage"]
          }),
          joinDeadline
        );
        const page = await context.newPage();
        await page.goto(input.meetingUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs(env.BOT_JOIN_TIMEOUT_MS, 90_000), remainingJoinMs(joinDeadline)) });
        const joinedState = await joinAsGuest(page, input, joinDeadline);
        await input.onState?.(joinedState);
        const bytes = await captureBrowserAudio(env, defaultAudioIo, audio.sinkName);
        return {
          bytes,
          contentType: contentTypeForFormat(env.BOT_RECORDING_FORMAT || "mp3"),
          joinMode: "guest"
        };
      } finally {
        if (context) await context.close().catch(() => undefined);
        if (!env.BOT_BROWSER_PROFILE_DIR) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        await audio.cleanup().catch(() => undefined);
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

async function joinAsGuest(page: any, input: RuntimeRecorderInput, deadline = createJoinDeadline(input.joinTimeoutSeconds)): Promise<"joined"> {
  if (!input.allowGuestJoin) throw new Error("Guest join is disabled for the meeting bot runtime");
  await input.onState?.("prejoin");
  return joinFromPrejoin(page, input, "guest", deadline);
}

async function clickTeamsWebEntry(page: any, visibleTimeout = 20_000, actionTimeout = visibleTimeout): Promise<boolean> {
  const clicked = await clickAny(
    locatorScopes(page).flatMap((scope) => [
      scope.getByRole("button", { name: /continue on this browser|join on the web|use the web app|continue without audio or video/i }),
      scope.getByRole("link", { name: /continue on this browser|join on the web|use the web app/i }),
      scope.getByText(/continue on this browser|join on the web|use the web app/i)
    ]),
    visibleTimeout,
    actionTimeout,
    { suppressClickErrors: true }
  );
  if (!clicked) return false;
  await page.waitForLoadState("domcontentloaded", { timeout: actionTimeout }).catch(() => undefined);
  return true;
}

async function fillGuestName(page: any, botName: string): Promise<boolean> {
  return fillAny(guestNameLocators(page), botName, 20_000);
}

async function joinFromPrejoin(page: any, input: RuntimeRecorderInput, mode: JoinMode, deadline: JoinDeadline): Promise<"joined"> {
  let filledName = false;
  let pressedEnter = false;
  let sawMeetingNotStarted = false;
  let sawLobby = false;

  for (let attempt = 0; attempt < MEETING_NOT_STARTED_MAX_ATTEMPTS; attempt += 1) {
    checkJoinDeadline(deadline);
    await clickTeamsWebEntry(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

    await dismissDevicePrompts(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

    filledName = (await fillAny(guestNameLocators(page), input.botName, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS)) || filledName;

    if (await clickAny(joinButtonLocators(page), CONTROL_PROBE_TIMEOUT_MS, 30_000, { suppressClickErrors: true })) {
      return waitForJoined(page, input, deadline, sawLobby);
    }

    if (filledName && !pressedEnter) {
      pressedEnter = await pressEnterFromPrejoin(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);
    }

    const stateAfterActions = await joinedOrLobbyState(page, CONTROL_PROBE_TIMEOUT_MS);
    if (stateAfterActions === "joined") return "joined";
    if (stateAfterActions === "waiting_room") {
      if (!sawLobby) {
        sawLobby = true;
        await input.onState?.("waiting_room");
      }
      return waitForJoined(page, input, deadline, sawLobby);
    }

    const blocker = await prejoinBlocker(page, mode, CONTROL_PROBE_TIMEOUT_MS);
    if (blocker) throw new Error(`${blocker} ${await prejoinDiagnostic(page)}`);

    if (await hasMeetingNotStartedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) {
      sawMeetingNotStarted = true;
      await waitForPoll(page, deadline);
      continue;
    }

    if (!sawMeetingNotStarted && attempt >= PREJOIN_MAX_ATTEMPTS - 1) break;
    await waitForPoll(page, deadline);
  }

  if (sawMeetingNotStarted) throw new Error(`Teams meeting did not start before the bot wait window expired. ${await prejoinDiagnostic(page)}`);
  const suffix = pressedEnter ? " after pressing Enter" : "";
  throw new Error(`Teams pre-join screen did not show a Join now button${suffix}. ${await prejoinDiagnostic(page)}`);
}

function joinButtonLocators(page: any): any[] {
  return locatorScopes(page).flatMap((scope) => [
    scope.getByRole("button", { name: /join now|ask to join|join/i }),
    scope.getByRole("link", { name: /join now|ask to join|join/i }),
    scope.getByText(/^(join now|ask to join|join)$/i),
    ...joinButtonSelectors().map((selector) => scope.locator(selector))
  ]);
}

function guestNameLocators(page: any): any[] {
  return locatorScopes(page).flatMap(guestNameLocatorsForScope);
}

function guestNameLocatorsForScope(scope: any): any[] {
  return [
    scope.getByRole("textbox", { name: /type your name|enter name|name/i }),
    scope.getByPlaceholder(/type your name|enter name|name/i),
    ...guestNameSelectors().map((selector) => scope.locator(selector))
  ];
}

function guestNameSelectors(): string[] {
  return [
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
}

function locatorScopes(page: any): any[] {
  const scopes = [page];
  const frames = typeof page.frames === "function" ? page.frames() : [];
  for (const frame of frames) {
    if (frame && frame !== page && typeof frame.locator === "function") scopes.push(frame);
  }
  return scopes;
}

async function dismissDevicePrompts(page: any, visibleTimeout = 3_000, actionTimeout = visibleTimeout): Promise<void> {
  await clickAny(locatorScopes(page).map((scope) => scope.getByRole("button", { name: /continue without audio or video/i })), visibleTimeout, actionTimeout, { suppressClickErrors: true });
  for (const scope of locatorScopes(page)) {
    for (const label of [/microphone/i, /camera/i]) {
      const toggle = scope.getByRole("switch", { name: label });
      const checked = await toggle.isChecked({ timeout: visibleTimeout }).catch(() => false);
      if (checked) await toggle.click({ timeout: actionTimeout }).catch(() => undefined);
    }
  }
}

async function waitForJoined(page: any, input: RuntimeRecorderInput, deadline: JoinDeadline, sawLobby: boolean): Promise<"joined"> {
  let sawMeetingNotStarted = false;
  let emittedLobby = sawLobby;

  for (let attempt = 0; attempt < MEETING_NOT_STARTED_MAX_ATTEMPTS; attempt += 1) {
    checkJoinDeadline(deadline);
    await clickAny(joinButtonLocators(page), CONTROL_PROBE_TIMEOUT_MS, 30_000, { suppressClickErrors: true });
    const state = await joinedOrLobbyState(page, CONTROL_PROBE_TIMEOUT_MS);
    if (state === "joined") return "joined";
    if (state === "waiting_room") {
      if (!emittedLobby) {
        emittedLobby = true;
        await input.onState?.("waiting_room");
      }
      await waitForPoll(page, deadline);
      continue;
    }

    if (await hasMeetingNotStartedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) {
      sawMeetingNotStarted = true;
      await waitForPoll(page, deadline);
      continue;
    }

    if (!sawMeetingNotStarted && attempt >= PREJOIN_MAX_ATTEMPTS - 1) break;
    await waitForPoll(page, deadline);
  }
  if (sawMeetingNotStarted) throw new Error(`Teams meeting did not start before the bot wait window expired. ${await prejoinDiagnostic(page)}`);
  throw new Error("Teams did not confirm joined or waiting room state after Join now");
}

async function joinedOrLobbyState(page: any, timeout: number): Promise<JoinedState | null> {
  if (await hasJoinedSignals(page, timeout)) return "joined";
  if (await hasLobbySignals(page, timeout)) return "waiting_room";
  return null;
}

async function hasJoinedSignals(page: any, timeout: number): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    if (await scope.getByRole("button", { name: /leave|hang up/i }).isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByRole("button", { name: /people|participants|chat/i }).isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByText(/you(?:'|’)re the only one here|meeting chat|participants/i).isVisible({ timeout }).catch(() => false)) return true;
  }
  return false;
}

async function hasLobbySignals(page: any, timeout: number): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    if (await scope.getByText(/someone.*let you in|waiting.*lobby|you(?:'|’)re in the lobby/i).isVisible({ timeout }).catch(() => false)) {
      return true;
    }
    if (await scope.getByText(/ask to join|admit/i).isVisible({ timeout }).catch(() => false)) return true;
  }
  return false;
}

async function hasMeetingNotStartedSignals(page: any, timeout: number): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    if (await scope.getByText(/when the meeting starts|meeting hasn(?:'|’)t started|meeting has not started|waiting for.*start/i).isVisible({ timeout }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function prejoinBlocker(page: any, mode: JoinMode, timeout: number): Promise<string | null> {
  if (mode !== "guest") return null;
  for (const scope of locatorScopes(page)) {
    if (
      await scope
        .getByText(/sign in to join|join without signing in is not available|anonymous users.*(disabled|not allowed)|guest.*(disabled|not allowed)|ask your admin|not authorized/i)
        .isVisible({ timeout })
        .catch(() => false)
    ) {
      return "Teams guest join is blocked or requires sign-in.";
    }
  }
  return null;
}

async function pressEnterFromPrejoin(page: any, visibleTimeout = 500, actionTimeout = 1_000): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    for (const target of guestNameLocatorsForScope(scope)) {
      if (await target.first().isVisible({ timeout: visibleTimeout }).catch(() => false)) {
        await target.first().press("Enter", { timeout: actionTimeout }).catch(() => undefined);
        return true;
      }
    }
  }
  return false;
}

async function prejoinDiagnostic(page: any): Promise<string> {
  const scopeDetails = await Promise.all(locatorScopes(page).map((scope, index) => diagnosticForScope(scope, index)));
  return truncateDiagnostic(
    [
      `diagnosticVersion=${sanitizeDiagnosticText(runtimeDiagnosticVersion())}`,
      `url=${redactUrl(await safeString(() => page.url()))}`,
      `frames=${frameUrls(page).map(redactUrl).join(",") || "none"}`,
      ...scopeDetails
    ]
      .filter(Boolean)
      .join(" | ")
  );
}

async function diagnosticForScope(scope: any, index: number): Promise<string> {
  const url = redactUrl(await safeString(() => typeof scope.url === "function" ? scope.url() : ""));
  const visibleControls = await safeEvaluate(scope, () => {
    const controls = Array.from(document.querySelectorAll("button,a,[role='button'],[role='link'],input,[aria-label],[title]"));
    return controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .slice(0, 16)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        text: element.textContent ?? "",
        aria: element.getAttribute("aria-label") ?? "",
        title: element.getAttribute("title") ?? "",
        placeholder: element.getAttribute("placeholder") ?? "",
        tid: element.getAttribute("data-tid") ?? "",
        id: element.id ?? ""
      }));
  });
  const ready = sanitizeDiagnosticText(String((await safeEvaluate(scope, () => document.readyState)) ?? "unknown"));
  const body = sanitizeDiagnosticText(String((await safeEvaluate(scope, () => document.body?.innerText ?? "")) ?? ""));
  const snippets = Array.isArray(visibleControls)
    ? visibleControls.map((control) => compactControl(control as Record<string, string>)).filter(Boolean).slice(0, 8)
    : [];
  const counts = await selectorCounts(scope, [...guestNameSelectors(), ...joinButtonSelectors()]);
  return `scope${index}{url=${url || "unknown"} ready=${ready || "unknown"} counts=${counts.join(",")} controls=${snippets.join(";") || "none"} body=${body || "empty"}}`;
}

function joinButtonSelectors(): string[] {
  return [
    'button[data-tid*="join" i]',
    '[role="button"][data-tid*="join" i]',
    'button[id*="join" i]',
    '[role="button"][id*="join" i]',
    'button[aria-label*="join" i]',
    '[role="button"][aria-label*="join" i]',
    'button[title*="join" i]',
    '[role="button"][title*="join" i]',
    'a[data-tid*="join" i]',
    'a[id*="join" i]',
    'a[aria-label*="join" i]',
    'a[title*="join" i]'
  ];
}

async function selectorCounts(scope: any, selectors: string[]): Promise<string[]> {
  const counts = await Promise.all(
    selectors.map(async (selector) => {
      const count = await scope.locator(selector).count({ timeout: 500 }).catch(() => 0);
      return count > 0 ? `${selector}:${count}` : "";
    })
  );
  return counts.filter(Boolean).slice(0, 8);
}

function compactControl(control: Record<string, string>): string {
  return sanitizeDiagnosticText(
    [control.tag, control.role, control.text, control.aria, control.title, control.placeholder, control.tid, control.id]
      .filter(Boolean)
      .join("/")
  );
}

async function safeEvaluate<T>(scope: any, fn: () => T): Promise<T | null> {
  if (typeof scope.evaluate !== "function") return null;
  return scope.evaluate(fn).catch(() => null);
}

async function safeString(fn: () => string): Promise<string> {
  try {
    return fn();
  } catch {
    return "";
  }
}

function frameUrls(page: any): string[] {
  const frames = typeof page.frames === "function" ? page.frames() : [];
  return frames.map((frame: any) => (frame && frame !== page && typeof frame.url === "function" ? frame.url() : "")).filter(Boolean);
}

function redactUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    const path = url.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return `${url.hostname}${path ? `/${path}` : ""}${url.search ? "?..." : ""}`;
  } catch {
    return sanitizeDiagnosticText(value);
  }
}

function sanitizeDiagnosticText(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/\s+/g, " ").trim().slice(0, 140);
}

function truncateDiagnostic(value: string): string {
  return value.length > 1_500 ? `${value.slice(0, 1_497)}...` : value;
}

function runtimeDiagnosticVersion(): string {
  return process.env.BOT_RUNTIME_VERSION?.trim() || "unknown";
}

async function clickAny(locators: any[], visibleTimeout: number, actionTimeout = visibleTimeout, options: { suppressClickErrors?: boolean } = {}): Promise<boolean> {
  for (const locator of locators) {
    if (await clickIfVisible(locator, visibleTimeout, actionTimeout, options)) return true;
  }
  return false;
}

async function fillAny(locators: any[], value: string, visibleTimeout: number, actionTimeout = visibleTimeout): Promise<boolean> {
  for (const locator of locators) {
    if (await fillIfVisible(locator, value, visibleTimeout, actionTimeout)) return true;
  }
  return false;
}

async function clickIfVisible(locator: any, visibleTimeout: number, actionTimeout = visibleTimeout, options: { suppressClickErrors?: boolean } = {}): Promise<boolean> {
  if (!(await locator.first().isVisible({ timeout: visibleTimeout }).catch(() => false))) return false;
  try {
    await locator.first().click({ timeout: actionTimeout });
  } catch (error) {
    if (options.suppressClickErrors) return false;
    throw error;
  }
  return true;
}

async function fillIfVisible(locator: any, value: string, visibleTimeout: number, actionTimeout = visibleTimeout): Promise<boolean> {
  if (!(await locator.first().isVisible({ timeout: visibleTimeout }).catch(() => false))) return false;
  await locator.first().fill(value, { timeout: actionTimeout });
  return true;
}

const defaultAudioIo: AudioIo = {
  mkdtemp: (prefix) => mkdtemp(prefix),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  rm,
  runCommand: runProcess
};

async function recordBrowserAudio(env: RuntimeProcessEnv, io: AudioIo = defaultAudioIo): Promise<Uint8Array> {
  const audio = await startPulseAudioSink(env, io);
  try {
    return await captureBrowserAudio(env, io, audio.sinkName);
  } finally {
    await audio.cleanup().catch(() => undefined);
  }
}

async function startPulseAudioSink(
  env: RuntimeProcessEnv,
  io: AudioIo = defaultAudioIo
): Promise<{ sinkName: string; cleanup: () => Promise<void> }> {
  const sinkName = env.BOT_AUDIO_SINK_NAME?.trim() || "teams_capture";
  await withProcessTimeout(env, io.runCommand("pulseaudio", ["--start"]), "pulseaudio");
  const moduleOutput = await withProcessTimeout(
    env,
    io.runCommand("pactl", [
      "load-module",
      "module-null-sink",
      `sink_name=${sinkName}`,
      "sink_properties=device.description=minutesbot_teams_capture"
    ]),
    "pactl"
  );
  const moduleId = typeof moduleOutput === "string" && moduleOutput.trim() ? moduleOutput.trim() : "0";
  return {
    sinkName,
    cleanup: () => withProcessTimeout(env, io.runCommand("pactl", ["unload-module", moduleId]), "pactl").then(() => undefined)
  };
}

async function captureBrowserAudio(env: RuntimeProcessEnv, io: AudioIo, sinkName: string): Promise<Uint8Array> {
  const dir = await io.mkdtemp(join(tmpdir(), "minutesbot-recording-"));
  const file = join(dir, "recording.mp3");
  const seconds = Math.max(1, Number(env.BOT_RECORDING_SECONDS ?? env.BOT_RECORDING_MAX_SECONDS ?? "3600"));
  try {
    await io.runCommand("ffmpeg", [
      "-y",
      "-f",
      "pulse",
      "-i",
      `${sinkName}.monitor`,
      "-t",
      String(seconds),
      "-ac",
      "1",
      "-ar",
      "16000",
      "-acodec",
      "libmp3lame",
      file
    ]);
    return await io.readFile(file);
  } finally {
    await io.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-500)}`));
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

function createJoinDeadline(seconds: number | undefined): JoinDeadline {
  const normalizedSeconds = Number.isFinite(seconds) && seconds && seconds > 0 ? Math.ceil(seconds) : DEFAULT_JOIN_TIMEOUT_SECONDS;
  return {
    seconds: normalizedSeconds,
    expiresAt: Date.now() + normalizedSeconds * 1_000
  };
}

function remainingJoinMs(deadline: JoinDeadline): number {
  return Math.max(1, deadline.expiresAt - Date.now());
}

function checkJoinDeadline(deadline: JoinDeadline): void {
  if (Date.now() >= deadline.expiresAt) throw new Error(joinTimeoutMessage(deadline));
}

function joinTimeoutMessage(deadline: JoinDeadline): string {
  return `Meeting bot did not join before the ${formatDurationSeconds(deadline.seconds)} timeout expired`;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

async function waitForPoll(page: any, deadline: JoinDeadline): Promise<void> {
  checkJoinDeadline(deadline);
  await page.waitForTimeout(Math.min(PREJOIN_POLL_INTERVAL_MS, remainingJoinMs(deadline)));
}

async function withJoinDeadline<T>(promise: Promise<T>, deadline: JoinDeadline): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(joinTimeoutMessage(deadline))), remainingJoinMs(deadline));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withProcessTimeout<T>(env: RuntimeProcessEnv, promise: Promise<T>, command: string): Promise<T> {
  const timeout = timeoutMs(env.BOT_PROCESS_TIMEOUT_MS, DEFAULT_PROCESS_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${command} timed out after ${timeout}ms`)), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const __runtimeTest = {
  fillGuestName,
  joinAsGuest,
  recordBrowserAudio
};
