import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRecorderError, UploadHttpError, type BotFailureStage, type BotRuntimeDeps, type RecorderDiagnostics } from "./app";

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
  runCommand: (command: string, args: string[], options?: { signal?: AbortSignal; killGraceMs?: number }) => Promise<string | void>;
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  readdir?: (path: string) => Promise<string[]>;
};

const PREJOIN_MAX_ATTEMPTS = 60;
const MEETING_NOT_STARTED_MAX_ATTEMPTS = 2 * 60 * 60;
const PREJOIN_POLL_INTERVAL_MS = 1_000;
const CONTROL_PROBE_TIMEOUT_MS = 1_500;
const CONTROL_ACTION_TIMEOUT_MS = 1_000;
const PREJOIN_DIAGNOSTIC_INTERVAL_MS = 15_000;
const DEFAULT_JOIN_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_PROCESS_TIMEOUT_MS = 30_000;
const DEFAULT_ABORT_KILL_GRACE_MS = 2_000;
const DEFAULT_JOIN_RETRY_ATTEMPTS = 3;
const TEAMS_MEDIA_PERMISSION_ORIGINS = ["https://teams.microsoft.com", "https://teams.live.com", "https://teams.cloud.microsoft"] as const;
const CHROMIUM_LAUNCH_ARGS = [
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-application-cache",
  "--window-size=1930,1090"
] as const;

/** Join deadline expiry; re-staged by callers that know lobby context. */
class JoinDeadlineError extends BotRecorderError {
  constructor(message: string) {
    super(message, "lobby_timeout", false);
    this.name = "JoinDeadlineError";
  }
}

export function createDefaultDeps(env: RuntimeProcessEnv): BotRuntimeDeps {
  return {
    env,
    checkBinary: async (name) => {
      if (name === "ffmpeg") return binaryAvailable("ffmpeg");
      if (name === "pulseaudio") return (await binaryAvailable("pulseaudio")) && (await binaryAvailable("pactl"));
      if (env.CHROMIUM_EXECUTABLE_PATH) return binaryAvailable(env.CHROMIUM_EXECUTABLE_PATH);
      return playwrightChromiumAvailable();
    },
    checkTempWritable: async () => {
      try {
        const dir = await mkdtemp(join(tmpdir(), "minutesbot-health-"));
        await rm(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
    recorder: createBrowserRecorder(env),
    splitRecording: createRecordingSplitter(),
    uploadArtifact: async ({ url, token, key, bytes, contentType }) => {
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": contentType,
          // The upload worker reads the destination object key from this
          // header (see deploy/bot-container/src/index.ts).
          "x-recording-key": key
        },
        body,
        signal: AbortSignal.timeout(timeoutMs(env.BOT_UPLOAD_TIMEOUT_MS, 300_000))
      });
      if (!response.ok) throw new UploadHttpError(response.status);
    },
    sendWebhook: async ({ url, token, body }) => {
      // A blackholed webhook endpoint must not wedge the bot lifecycle while
      // Chromium/ffmpeg resources stay alive.
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(timeoutMs(env.BOT_WEBHOOK_TIMEOUT_MS, 15_000))
      });
      if (!response.ok) throw new Error(`Webhook delivery returned ${response.status}`);
    }
  };
}

const CONSOLE_TAIL_LIMIT = 100;

function createBrowserRecorder(env: RuntimeProcessEnv): BotRuntimeDeps["recorder"] {
  return {
    async record(input) {
      const fixturePath = env.BOT_RECORDING_FIXTURE_PATH;
      if (fixturePath) {
        return {
          bytes: new Uint8Array(await readFile(fixturePath)),
          contentType: contentTypeForFormat(env.BOT_RECORDING_FORMAT || "mp3")
        };
      }

      const joinDeadline = createJoinDeadline(input.joinTimeoutSeconds);
      await input.onState?.("warming");
      // Each recording gets its own null sink: concurrent meetings sharing a
      // sink would either fail to load the module or mix each other's audio
      // into the capture — a cross-meeting confidentiality breach.
      const sinkName = uniqueSinkName(env);
      await input.onLog?.({ level: "info", message: "Starting browser audio capture", details: { sinkName } });
      let audio: { sinkName: string; cleanup: () => Promise<void> };
      try {
        audio = await withJoinDeadline(startPulseAudioSink(env, defaultAudioIo, sinkName), joinDeadline);
      } catch (error) {
        throw asStagedError(error, "audio_setup", false, "PulseAudio capture setup failed");
      }
      await input.onLog?.({ level: "info", message: "Browser audio capture ready", details: { sinkName: audio.sinkName } });
      const userDataDir = env.BOT_BROWSER_PROFILE_DIR || (await mkdtemp(join(tmpdir(), "minutesbot-profile-")));
      let context: any;
      let activePage: any;
      const consoleTail: string[] = [];
      try {
        await input.onState?.("browser_starting");
        await input.onLog?.({ level: "info", message: "Loading Chromium runtime" });
        let browser: any;
        try {
          browser = await withJoinDeadline(loadPlaywrightChromium(), joinDeadline);
        } catch (error) {
          throw asStagedError(error, "browser_launch", true, "Chromium runtime failed to load");
        }
        await input.onLog?.({ level: "info", message: "Launching Teams browser", details: { headless: env.BOT_HEADLESS !== "false" } });
        const joinedState = await joinWithRetries(
          async () => {
            if (context) await context.close().catch(() => undefined);
            try {
              context = await withJoinDeadline(
                browser.launchPersistentContext(userDataDir, {
                  headless: env.BOT_HEADLESS !== "false",
                  executablePath: env.CHROMIUM_EXECUTABLE_PATH,
                  env: { ...process.env, PULSE_SINK: audio.sinkName },
                  args: [...CHROMIUM_LAUNCH_ARGS]
                }),
                joinDeadline
              );
            } catch (error) {
              throw asStagedError(error, "browser_launch", true, "Chromium launch failed");
            }
            await grantTeamsMediaPermissions(context, input.meetingUrl);
            const page = await context.newPage();
            activePage = page;
            trackConsoleTail(page, consoleTail);
            await input.onLog?.({ level: "info", message: "Opening Teams meeting URL" });
            try {
              await page.goto(input.meetingUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs(env.BOT_JOIN_TIMEOUT_MS, 90_000), remainingJoinMs(joinDeadline)) });
            } catch (error) {
              throw asStagedError(error, "navigation", true, "Teams navigation failed");
            }
            return page;
          },
          input,
          joinDeadline,
          DEFAULT_JOIN_RETRY_ATTEMPTS,
          async (attempt, error) => {
            await input.onLog?.({ level: "warning", message: "Retrying Teams guest join", details: { attempt, error: error.message } });
          }
        );
        await input.onState?.(joinedState);
        await input.onState?.("recording");
        const meetingEndController = new AbortController();
        const abortMeetingEndWatcher = () => meetingEndController.abort();
        input.abortSignal?.addEventListener("abort", abortMeetingEndWatcher, { once: true });
        try {
          const stopWhen = activePage
            ? waitForTeamsMeetingEnd(activePage, meetingEndController.signal).then(async (reason) => {
                if (meetingEndController.signal.aborted) return;
                await input.onLog?.({ level: "info", message: "Teams meeting ended; stopping recording", details: { reason } });
              })
            : undefined;
          let bytes: Uint8Array;
          try {
            bytes = await captureBrowserAudio(env, defaultAudioIo, audio.sinkName, {
              signal: input.abortSignal,
              stopWhen,
              maxDurationSeconds: input.maxDurationSeconds
            });
          } catch (error) {
            throw asStagedError(error, "recording", false, "Audio capture failed");
          }
          return {
            bytes,
            contentType: contentTypeForFormat(env.BOT_RECORDING_FORMAT || "mp3")
          };
        } finally {
          input.abortSignal?.removeEventListener("abort", abortMeetingEndWatcher);
          meetingEndController.abort();
        }
      } catch (error) {
        // Diagnostics must be captured here, BEFORE the finally below closes
        // the browser context and deletes the temp profile.
        throw await toRecorderError(error, activePage, consoleTail);
      } finally {
        if (context) await context.close().catch(() => undefined);
        if (!env.BOT_BROWSER_PROFILE_DIR) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        await audio.cleanup().catch(() => undefined);
      }
    }
  };
}

function createRecordingSplitter(io: AudioIo = defaultAudioIo): BotRuntimeDeps["splitRecording"] {
  return async ({ bytes, chunkSeconds }) => {
    const dir = await io.mkdtemp(join(tmpdir(), "minutesbot-chunks-"));
    try {
      const source = join(dir, "recording.mp3");
      await (io.writeFile ?? writeFile)(source, bytes);
      // Stream copy: segmenting an already-encoded MP3 needs no re-encode.
      await io.runCommand("ffmpeg", ["-y", "-i", source, "-f", "segment", "-segment_time", String(chunkSeconds), "-c", "copy", join(dir, "chunk-%03d.mp3")]);
      const names = (await (io.readdir ?? readdir)(dir)).filter((name) => /^chunk-\d{3}\.mp3$/.test(name)).sort();
      return await Promise.all(names.map(async (name) => io.readFile(join(dir, name))));
    } finally {
      await io.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

function trackConsoleTail(page: any, tail: string[]): void {
  if (typeof page?.on !== "function") return;
  page.on("console", (message: any) => {
    try {
      tail.push(`${typeof message?.type === "function" ? message.type() : "log"}: ${typeof message?.text === "function" ? message.text() : ""}`);
      if (tail.length > CONSOLE_TAIL_LIMIT) tail.splice(0, tail.length - CONSOLE_TAIL_LIMIT);
    } catch {
      // Console bookkeeping must never break the join flow.
    }
  });
}

async function toRecorderError(error: unknown, page: any, consoleTail: string[]): Promise<BotRecorderError> {
  const base = error instanceof BotRecorderError ? error : new BotRecorderError(errorText(error), "internal", false);
  if (base.diagnostics) return base;
  const diagnostics = await capturePageDiagnostics(page, consoleTail);
  return new BotRecorderError(base.message, base.stage, base.retryable, diagnostics);
}

async function capturePageDiagnostics(page: any, consoleTail: string[]): Promise<RecorderDiagnostics> {
  const diagnostics: RecorderDiagnostics = {};
  if (consoleTail.length > 0) diagnostics.consoleLines = [...consoleTail];
  if (!page) return diagnostics;
  if (typeof page.screenshot === "function") {
    const screenshot = await page.screenshot({ type: "png" }).catch(() => null);
    if (screenshot) diagnostics.screenshotPng = new Uint8Array(screenshot);
  }
  if (typeof page.content === "function") {
    const html = await page.content().catch(() => null);
    if (typeof html === "string" && html) diagnostics.pageHtml = html;
  }
  const visibleText = await safeEvaluate(page, () => document.body?.innerText ?? "");
  if (typeof visibleText === "string" && visibleText) diagnostics.visibleText = visibleText;
  return diagnostics;
}

function asStagedError(error: unknown, stage: BotFailureStage, retryable: boolean, prefix: string): BotRecorderError {
  if (error instanceof BotRecorderError) return error;
  return new BotRecorderError(`${prefix}: ${errorText(error)}`, stage, retryable);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadPlaywrightChromium(): Promise<any> {
  const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
  const playwright = await importer("playwright");
  return playwright.chromium;
}

async function joinAsGuest(page: any, input: RuntimeRecorderInput, deadline = createJoinDeadline(input.joinTimeoutSeconds)): Promise<"joined"> {
  if (!input.allowGuestJoin) throw new BotRecorderError("Guest join is disabled for the meeting bot runtime", "policy_blocked", false);
  await grantTeamsMediaPermissions(page.context?.(), input.meetingUrl);
  await input.onLog?.({ level: "info", message: "Starting Teams guest join flow" });
  await input.onState?.("prejoin");
  return joinFromPrejoin(page, input, "guest", deadline);
}

async function joinWithRetries(
  pageFactory: () => any | Promise<any>,
  input: RuntimeRecorderInput,
  deadline: JoinDeadline,
  maxAttempts = DEFAULT_JOIN_RETRY_ATTEMPTS,
  onRetry?: (attempt: number, error: Error) => Promise<void>
): Promise<"joined"> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    checkJoinDeadline(deadline);
    try {
      // Page creation runs inside the retry loop so transient browser-launch
      // and navigation failures get the same retry budget as join failures.
      const page = await pageFactory();
      return await joinAsGuest(page, input, deadline);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableJoinError(lastError) || attempt >= maxAttempts) throw lastError;
      await onRetry?.(attempt, lastError);
    }
  }
  throw lastError ?? new BotRecorderError("Teams guest join failed", "page_load", false);
}

async function grantTeamsMediaPermissions(context: any, meetingUrl: string): Promise<void> {
  if (!context || typeof context.grantPermissions !== "function") return;
  const origins = new Set<string>(TEAMS_MEDIA_PERMISSION_ORIGINS);
  try {
    origins.add(new URL(meetingUrl).origin);
  } catch {
    // Still grant the known Teams origins when the meeting URL is malformed.
  }
  for (const origin of origins) {
    await context.grantPermissions(["geolocation", "microphone", "camera"], { origin }).catch(() => undefined);
  }
}

async function clickTeamsWebEntry(page: any, visibleTimeout = 20_000, actionTimeout = visibleTimeout): Promise<boolean> {
  const clicked = await clickAny(webEntryLocators(page), visibleTimeout, actionTimeout, { suppressClickErrors: true });
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
  let inWaitingForStart = false;
  let lastDiagnosticAt = Date.now();
  const leaveWaitingForStart = async () => {
    // waiting_for_start ⇄ prejoin: return to prejoin before any forward move.
    if (!inWaitingForStart) return;
    inWaitingForStart = false;
    await input.onState?.("prejoin");
  };

  try {
    for (let attempt = 0; attempt < MEETING_NOT_STARTED_MAX_ATTEMPTS; attempt += 1) {
      checkJoinDeadline(deadline);
      await emitPrejoinDiagnosticIfDue(page, input, attempt + 1, lastDiagnosticAt).then((emitted) => {
        if (emitted) lastDiagnosticAt = Date.now();
      });
      await throwIfTeamsBlocker(page, mode, CONTROL_PROBE_TIMEOUT_MS);
      await clickTeamsWebEntry(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

      await turnOffMediaInputs(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);
      await dismissDevicePrompts(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

      filledName = (await fillAny(guestNameLocators(page), input.displayName, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS)) || filledName;
      await turnOffMediaInputs(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

      if (await clickAny(joinButtonLocators(page), CONTROL_PROBE_TIMEOUT_MS, 30_000, { suppressClickErrors: true })) {
        await leaveWaitingForStart();
        if (await hasJoinedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) return "joined";
        await input.onLog?.({ level: "info", message: "Clicked Teams join control; waiting for admission" });
        await input.onState?.("waiting_room");
        return await waitForJoined(page, input, deadline, true);
      }

      if (filledName && !pressedEnter) {
        pressedEnter = await pressEnterFromPrejoin(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);
      }

      const stateAfterActions = await joinedOrLobbyState(page, CONTROL_PROBE_TIMEOUT_MS);
      if (stateAfterActions === "joined") {
        await leaveWaitingForStart();
        return "joined";
      }
      if (stateAfterActions === "waiting_room") {
        await leaveWaitingForStart();
        if (!sawLobby) {
          sawLobby = true;
          await input.onLog?.({ level: "info", message: "Waiting in Teams lobby" });
          await input.onState?.("waiting_room");
        }
        return await waitForJoined(page, input, deadline, sawLobby);
      }

      await throwIfTeamsBlocker(page, mode, CONTROL_PROBE_TIMEOUT_MS);

      if (await hasMeetingNotStartedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) {
        sawMeetingNotStarted = true;
        if (!inWaitingForStart) {
          inWaitingForStart = true;
          await input.onLog?.({ level: "info", message: "Teams meeting has not started; waiting" });
          await input.onState?.("waiting_for_start");
        }
        await waitForPoll(page, deadline);
        continue;
      }
      await leaveWaitingForStart();

      if (!sawMeetingNotStarted && attempt >= PREJOIN_MAX_ATTEMPTS - 1) break;
      await waitForPoll(page, deadline);
    }
  } catch (error) {
    throw restageDeadlineError(error, sawMeetingNotStarted, sawLobby);
  }

  if (sawMeetingNotStarted) {
    await clickCancelJoinButton(page);
    throw new BotRecorderError(`Teams meeting did not start before the bot wait window expired. ${await prejoinDiagnostic(page)}`, "meeting_not_started_timeout", false);
  }
  const suffix = pressedEnter ? " after pressing Enter" : "";
  throw new BotRecorderError(`Teams pre-join screen did not show a Join now button${suffix}. ${await prejoinDiagnostic(page)}`, "page_load", true);
}

/**
 * The join deadline is the lobby/not-started budget: when it expires, the
 * surrounding wait context decides which terminal stage to report.
 */
function restageDeadlineError(error: unknown, sawMeetingNotStarted: boolean, sawLobby: boolean): unknown {
  if (!(error instanceof JoinDeadlineError)) return error;
  if (sawMeetingNotStarted && !sawLobby) return new BotRecorderError(error.message, "meeting_not_started_timeout", false);
  return new BotRecorderError(error.message, "lobby_timeout", false);
}

function joinButtonLocators(page: any): any[] {
  return locatorScopes(page).flatMap((scope) => [
    scope.locator('button[data-tid="prejoin-join-button"]'),
    scope.locator("button#prejoin-join-button"),
    scope.locator('[data-tid="prejoin-join-button"]'),
    scope.getByRole("button", { name: /join now|ask to join|join/i }),
    scope.getByRole("link", { name: /join now|ask to join|join/i }),
    scope.getByText(/^(join now|ask to join|join)$/i),
    ...joinButtonSelectors().map((selector) => scope.locator(selector))
  ]);
}

function webEntryLocators(page: any): any[] {
  return locatorScopes(page).flatMap((scope) => [
    scope.getByRole("button", { name: /continue on this browser|join on the web|use the web app|continue without audio or video/i }),
    scope.getByRole("link", { name: /continue on this browser|join on the web|use the web app/i }),
    scope.getByText(/continue on this browser|join on the web|use the web app/i),
    ...webEntrySelectors().map((selector) => scope.locator(selector))
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

async function turnOffMediaInputs(page: any, visibleTimeout = 3_000, actionTimeout = visibleTimeout): Promise<void> {
  for (const scope of locatorScopes(page)) {
    await clickIfChecked(scope.locator('[data-tid="toggle-mute"]'), visibleTimeout, actionTimeout);
    await clickIfChecked(scope.locator('[data-tid="toggle-video"]'), visibleTimeout, actionTimeout);
  }
}

async function waitForJoined(page: any, input: RuntimeRecorderInput, deadline: JoinDeadline, sawLobby: boolean): Promise<"joined"> {
  let sawMeetingNotStarted = false;
  let emittedLobby = sawLobby;

  try {
    for (let attempt = 0; attempt < MEETING_NOT_STARTED_MAX_ATTEMPTS; attempt += 1) {
      checkJoinDeadline(deadline);
      await clickAny(joinButtonLocators(page), CONTROL_PROBE_TIMEOUT_MS, 30_000, { suppressClickErrors: true });
      const state = await joinedOrLobbyState(page, CONTROL_PROBE_TIMEOUT_MS);
      if (state === "joined") return "joined";
      if (state === "waiting_room") {
        if (!emittedLobby) {
          emittedLobby = true;
          await input.onLog?.({ level: "info", message: "Waiting in Teams lobby" });
          await input.onState?.("waiting_room");
        }
        await waitForPoll(page, deadline);
        continue;
      }

      await throwIfTeamsBlocker(page, "guest", CONTROL_PROBE_TIMEOUT_MS);

      if (await hasMeetingNotStartedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) {
        sawMeetingNotStarted = true;
        await waitForPoll(page, deadline);
        continue;
      }

      if (!sawMeetingNotStarted && attempt >= PREJOIN_MAX_ATTEMPTS - 1) break;
      await waitForPoll(page, deadline);
    }
  } catch (error) {
    throw restageDeadlineError(error, sawMeetingNotStarted, emittedLobby);
  }
  if (sawMeetingNotStarted) {
    await clickCancelJoinButton(page);
    throw new BotRecorderError(`Teams meeting did not start before the bot wait window expired. ${await prejoinDiagnostic(page)}`, "meeting_not_started_timeout", false);
  }
  throw new BotRecorderError("Teams did not confirm joined or waiting room state after Join now", "page_load", true);
}

async function joinedOrLobbyState(page: any, timeout: number): Promise<JoinedState | null> {
  if (await hasJoinedSignals(page, timeout)) return "joined";
  if (await hasLobbySignals(page, timeout)) return "waiting_room";
  return null;
}

async function hasJoinedSignals(page: any, timeout: number): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    if (await scope.locator("#callingButtons-showMoreBtn").isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByRole("button", { name: /leave|hang up/i }).isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByRole("button", { name: /people|participants|chat/i }).isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByText(/you(?:'|’)re the only one here|meeting chat|participants/i).isVisible({ timeout }).catch(() => false)) return true;
  }
  return false;
}

async function hasMeetingEndedSignals(page: any, timeout: number): Promise<boolean> {
  return (await meetingEndReason(page, timeout)) !== null;
}

async function hasRemovedFromMeetingSignals(page: any, timeout: number): Promise<boolean> {
  return (await meetingEndReason(page, timeout)) === "removed";
}

async function meetingEndReason(page: any, timeout: number): Promise<"meeting_ended" | "removed" | "left" | null> {
  for (const scope of locatorScopes(page)) {
    if (
      await scope
        .getByText(/you(?:'|’)ve been removed from this meeting|removed from (?:this|the) meeting|someone removed you|no longer in this meeting/i)
        .isVisible({ timeout })
        .catch(() => false)
    ) {
      return "removed";
    }
    if (
      await scope
        .getByText(/you(?:'|’)ve left the meeting|you left the meeting/i)
        .isVisible({ timeout })
        .catch(() => false)
    ) {
      return "left";
    }
    if (
      await scope
        .getByText(/meeting ended|this meeting has ended|the meeting has ended|meeting has ended|call ended|thanks for joining/i)
        .isVisible({ timeout })
        .catch(() => false)
    ) {
      return "meeting_ended";
    }
    const leaveVisible = await scope.getByRole("button", { name: /leave|hang up/i }).isVisible({ timeout }).catch(() => false);
    const inCallVisible = await scope.getByRole("button", { name: /people|participants|chat/i }).isVisible({ timeout }).catch(() => false);
    if (!leaveVisible && !inCallVisible && await scope.getByText(/return to calendar|return to home|rejoin|join again|dismiss/i).isVisible({ timeout }).catch(() => false)) {
      return "meeting_ended";
    }
  }
  return null;
}

async function waitForTeamsMeetingEnd(page: any, signal: AbortSignal): Promise<"meeting_ended" | "removed" | "left"> {
  while (!signal.aborted) {
    const reason = await meetingEndReason(page, CONTROL_PROBE_TIMEOUT_MS);
    if (reason) return reason;
    // Out-of-band sleep: page.waitForTimeout rejects instantly once the page
    // is closed, which would turn this loop into a CPU-pegging busy-wait.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return "left";
}

async function hasLobbySignals(page: any, timeout: number): Promise<boolean> {
  const lobbyPattern =
    /someone.*let you in|you(?:'|’)re in the lobby|waiting.*lobby|people.*know.*you(?:'|’)re waiting|we(?:'|’)ve let.*know.*waiting|you(?:'|’)ll join when someone lets you in|hang tight|wait.*admit|waiting to be admitted/i;
  for (const scope of locatorScopes(page)) {
    if (await scope.getByText(lobbyPattern).isVisible({ timeout }).catch(() => false)) return true;
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

async function throwIfTeamsBlocker(page: any, mode: JoinMode, timeout: number): Promise<void> {
  if (mode === "guest") {
    for (const scope of locatorScopes(page)) {
      if (await scope.locator('input[name="loginfmt"][type="email"]').isVisible({ timeout }).catch(() => false)) {
        throw new BotRecorderError(`Microsoft login form detected. ${await prejoinDiagnostic(page)}`, "sign_in_required", false);
      }
      if (
        await scope
          .getByText(/anonymous users.*(disabled|not allowed)|guest.*(disabled|not allowed)|ask your admin|not authorized|due to org policy/i)
          .isVisible({ timeout })
          .catch(() => false)
      ) {
        throw new BotRecorderError(`Teams guest join is blocked by organization policy. ${await prejoinDiagnostic(page)}`, "policy_blocked", false);
      }
      if (
        await scope
          .getByText(/sign in to join|join without signing in is not available|we need to verify your info|to join, sign in|sign in to teams|need to be signed in/i)
          .isVisible({ timeout })
          .catch(() => false)
      ) {
        throw new BotRecorderError(`Teams guest join is blocked or requires sign-in. ${await prejoinDiagnostic(page)}`, "sign_in_required", false);
      }
    }
  }
  for (const scope of locatorScopes(page)) {
    if (await scope.getByText(/verify you(?:'|’)re a real person/i).isVisible({ timeout }).catch(() => false)) {
      throw new BotRecorderError(`Teams blocked guest join with a captcha. ${await prejoinDiagnostic(page)}`, "captcha", false);
    }
    if (await scope.getByText(/but you were denied access to the meeting|your request to join was declined/i).isVisible({ timeout }).catch(() => false)) {
      throw new BotRecorderError(`Someone in the meeting denied the bot request to join. ${await prejoinDiagnostic(page)}`, "admission_denied", false);
    }
    if (await scope.getByText(/meeting (?:has )?ended|this meeting has ended|call ended/i).isVisible({ timeout }).catch(() => false)) {
      throw new BotRecorderError(`Teams meeting already ended before the bot could join. ${await prejoinDiagnostic(page)}`, "meeting_ended", false);
    }
    if (await scope.getByText(/we couldn(?:'|’)t connect you/i).isVisible({ timeout }).catch(() => false)) {
      throw new BotRecorderError(`Teams could not connect the bot. ${await prejoinDiagnostic(page)}`, "navigation", true);
    }
  }
}

async function clickCancelJoinButton(page: any): Promise<void> {
  await clickAny(
    locatorScopes(page).map((scope) => scope.locator('[data-tid="prejoin-cancel-button"]')),
    CONTROL_PROBE_TIMEOUT_MS,
    CONTROL_ACTION_TIMEOUT_MS,
    { suppressClickErrors: true }
  );
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

async function emitPrejoinDiagnosticIfDue(page: any, input: RuntimeRecorderInput, attempt: number, lastDiagnosticAt: number): Promise<boolean> {
  if (Date.now() - lastDiagnosticAt < PREJOIN_DIAGNOSTIC_INTERVAL_MS) return false;
  const details = await prejoinDiagnosticDetails(page, attempt);
  await input.onLog?.({ level: "info", message: "Teams prejoin diagnostic", details });
  return true;
}

async function prejoinDiagnosticDetails(page: any, attempt: number): Promise<Record<string, unknown>> {
  const [controls, hasNameField, hasJoinButton, hasWebEntryLocator, hasLobbyText, hasJoinedSignal, diagnostic] = await Promise.all([
    compactVisibleControls(page),
    hasVisibleLocator(guestNameLocators(page), CONTROL_PROBE_TIMEOUT_MS),
    hasVisibleLocator(joinButtonLocators(page), CONTROL_PROBE_TIMEOUT_MS),
    hasVisibleLocator(webEntryLocators(page), CONTROL_PROBE_TIMEOUT_MS),
    hasLobbySignals(page, CONTROL_PROBE_TIMEOUT_MS),
    hasJoinedSignals(page, CONTROL_PROBE_TIMEOUT_MS),
    prejoinDiagnostic(page)
  ]);
  const controlText = controls.join(" ").toLowerCase();
  return {
    attempt,
    url: redactUrl(await safeString(() => page.url())),
    controls,
    hasNameField,
    hasJoinButton,
    hasWebEntryButton:
      hasWebEntryLocator || /continue on this browser|join on the web|join-on-web|joinonweb|use the web app/.test(controlText),
    hasLobbyText,
    hasJoinedSignal,
    diagnostic
  };
}

async function compactVisibleControls(page: any): Promise<string[]> {
  const controlsByScope = await Promise.all(locatorScopes(page).map((scope) => visibleControlsForScope(scope)));
  return controlsByScope.flat().filter(Boolean).slice(0, 8);
}

async function diagnosticForScope(scope: any, index: number): Promise<string> {
  const url = redactUrl(await safeString(() => typeof scope.url === "function" ? scope.url() : ""));
  const visibleControls = await visibleControlRecords(scope);
  const ready = sanitizeDiagnosticText(String((await safeEvaluate(scope, () => document.readyState)) ?? "unknown"));
  const body = sanitizeDiagnosticText(String((await safeEvaluate(scope, () => document.body?.innerText ?? "")) ?? ""));
  const snippets = Array.isArray(visibleControls)
    ? visibleControls.map((control) => compactControl(control as Record<string, string>)).filter(Boolean).slice(0, 8)
    : [];
  const counts = await selectorCounts(scope, [...guestNameSelectors(), ...joinButtonSelectors(), ...webEntrySelectors()]);
  return `scope${index}{url=${url || "unknown"} ready=${ready || "unknown"} counts=${counts.join(",")} controls=${snippets.join(";") || "none"} body=${body || "empty"}}`;
}

async function visibleControlsForScope(scope: any): Promise<string[]> {
  const visibleControls = await visibleControlRecords(scope);
  return Array.isArray(visibleControls)
    ? visibleControls.map((control) => compactControl(control as Record<string, string>)).filter(Boolean).slice(0, 8)
    : [];
}

async function visibleControlRecords(scope: any): Promise<unknown[] | null> {
  return safeEvaluate(scope, () => {
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
}

function joinButtonSelectors(): string[] {
  return [
    'button[data-tid="prejoin-join-button"]',
    "button#prejoin-join-button",
    'button[data-tid*="join" i]',
    '[role="button"][data-tid*="join" i]',
    'button[id*="join" i]',
    '[role="button"][id*="join" i]',
    'button[aria-label*="ask to join" i]',
    'button[aria-label*="join now" i]',
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

function webEntrySelectors(): string[] {
  return [
    'button[data-tid*="join-on-web" i]',
    'button[data-tid*="joinOnWeb" i]',
    'button[aria-label*="continue on this browser" i]',
    'button[aria-label*="join on the web" i]'
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

async function hasVisibleLocator(locators: any[], visibleTimeout: number): Promise<boolean> {
  for (const locator of locators) {
    if (await locator.first().isVisible({ timeout: visibleTimeout }).catch(() => false)) return true;
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

async function clickIfChecked(locator: any, visibleTimeout: number, actionTimeout = visibleTimeout): Promise<boolean> {
  const target = locator.first();
  if (!(await target.isVisible({ timeout: visibleTimeout }).catch(() => false))) return false;
  const checked = await target.isChecked({ timeout: visibleTimeout }).catch(() => false);
  if (!checked) return false;
  await target.click({ timeout: actionTimeout }).catch(() => undefined);
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

async function recordBrowserJoinedAudio(
  env: RuntimeProcessEnv,
  io: AudioIo = defaultAudioIo,
  onState?: (state: "recording") => Promise<void>
): Promise<Uint8Array> {
  const audio = await startPulseAudioSink(env, io);
  try {
    await onState?.("recording");
    return await captureBrowserAudio(env, io, audio.sinkName);
  } finally {
    await audio.cleanup().catch(() => undefined);
  }
}

function uniqueSinkName(env: RuntimeProcessEnv): string {
  const base = env.BOT_AUDIO_SINK_NAME?.trim() || "teams_capture";
  return `${base}_${crypto.randomUUID().slice(0, 8)}`;
}

async function startPulseAudioSink(
  env: RuntimeProcessEnv,
  io: AudioIo = defaultAudioIo,
  sinkName = env.BOT_AUDIO_SINK_NAME?.trim() || "teams_capture"
): Promise<{ sinkName: string; cleanup: () => Promise<void> }> {
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
  const moduleId = typeof moduleOutput === "string" && moduleOutput.trim() ? moduleOutput.trim() : null;
  return {
    sinkName,
    cleanup: async () => {
      // Without a parsed module id, skip the unload: unloading a guessed id
      // (the old fallback was "0") could tear down another recording's sink.
      if (!moduleId) return;
      await withProcessTimeout(env, io.runCommand("pactl", ["unload-module", moduleId]), "pactl");
    }
  };
}

async function captureBrowserAudio(
  env: RuntimeProcessEnv,
  io: AudioIo,
  sinkName: string,
  options: { signal?: AbortSignal; stopWhen?: Promise<unknown>; maxDurationSeconds?: number } = {}
): Promise<Uint8Array> {
  const dir = await io.mkdtemp(join(tmpdir(), "minutesbot-recording-"));
  const file = join(dir, "recording.mp3");
  // ffmpeg -t is the hard recording cap: even if every stop signal fails,
  // the capture cannot run past maxDurationSeconds.
  const seconds = options.maxDurationSeconds ?? positiveIntOr(env.BOT_RECORDING_SECONDS ?? env.BOT_RECORDING_MAX_SECONDS, 3600);
  const captureController = new AbortController();
  const abortCapture = () => {
    if (!captureController.signal.aborted) captureController.abort();
  };
  options.signal?.addEventListener("abort", abortCapture, { once: true });
  if (options.signal?.aborted) abortCapture();
  let stopWhenSettled = false;
  void options.stopWhen
    ?.then(() => {
      stopWhenSettled = true;
      abortCapture();
    })
    .catch(() => undefined);
  try {
    try {
      await io.runCommand(
        "ffmpeg",
        [
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
        ],
        { signal: captureController.signal }
      );
    } catch (error) {
      if (!captureController.signal.aborted) throw error;
    }
    const bytes = await io.readFile(file).catch((error) => {
      if (captureController.signal.aborted || stopWhenSettled) throw new Error(`ffmpeg stopped before producing recording bytes: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    if (bytes.byteLength === 0 && (captureController.signal.aborted || stopWhenSettled)) {
      throw new Error("ffmpeg stopped before producing recording bytes");
    }
    return bytes;
  } finally {
    options.signal?.removeEventListener("abort", abortCapture);
    await io.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runProcess(command: string, args: string[], options: { signal?: AbortSignal; killGraceMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (closed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, options.killGraceMs ?? DEFAULT_ABORT_KILL_GRACE_MS);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(error);
    });
    child.on("close", (code) => {
      closed = true;
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8").slice(-500)}`));
    });
    if (options.signal?.aborted) abort();
  });
}

// Async spawn: the health endpoint shares the event loop with every live
// recording, so synchronous process spawns would stall them.
async function binaryAvailable(name: string): Promise<boolean> {
  if (await commandSucceeds(name, ["--version"])) return true;
  return commandSucceeds("which", [name]);
}

function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function playwrightChromiumAvailable(): Promise<boolean> {
  try {
    const browser = await loadPlaywrightChromium();
    return binaryAvailable(browser.executablePath());
  } catch {
    return false;
  }
}

function positiveIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
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
  if (Date.now() >= deadline.expiresAt) throw new JoinDeadlineError(joinTimeoutMessage(deadline));
}

function joinTimeoutMessage(deadline: JoinDeadline): string {
  return `Meeting bot did not join before the ${formatDurationSeconds(deadline.seconds)} timeout expired`;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function isRetryableJoinError(error: Error): boolean {
  return error instanceof BotRecorderError ? error.retryable : true;
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
        timer = setTimeout(() => reject(new JoinDeadlineError(joinTimeoutMessage(deadline))), remainingJoinMs(deadline));
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
  captureBrowserAudio,
  chromiumLaunchArgs: CHROMIUM_LAUNCH_ARGS,
  createJoinDeadline,
  createRecordingSplitter,
  fillGuestName,
  hasMeetingEndedSignals,
  hasRemovedFromMeetingSignals,
  joinAsGuest,
  joinWithRetries,
  recordBrowserJoinedAudio,
  recordBrowserAudio,
  runProcess,
  waitForTeamsMeetingEnd
};
