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
  runCommand: (command: string, args: string[], options?: { signal?: AbortSignal; killGraceMs?: number }) => Promise<string | void>;
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

class TeamsJoinError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "TeamsJoinError";
  }
}

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
      await input.onLog?.({ level: "info", message: "Starting browser audio capture", details: { sinkName: env.BOT_AUDIO_SINK_NAME?.trim() || "teams_capture" } });
      const audio = await withJoinDeadline(startPulseAudioSink(env), joinDeadline);
      await input.onLog?.({ level: "info", message: "Browser audio capture ready", details: { sinkName: audio.sinkName } });
      const userDataDir = env.BOT_BROWSER_PROFILE_DIR || (await mkdtemp(join(tmpdir(), "minutesbot-profile-")));
      let context: any;
      let activePage: any;
      try {
        await input.onLog?.({ level: "info", message: "Loading Chromium runtime" });
        const browser = await withJoinDeadline(loadPlaywrightChromium(), joinDeadline);
        await input.onLog?.({ level: "info", message: "Launching Teams browser", details: { headless: env.BOT_HEADLESS !== "false" } });
        const joinedState = await joinWithRetries(
          async () => {
            if (context) await context.close().catch(() => undefined);
            context = await withJoinDeadline(
              browser.launchPersistentContext(userDataDir, {
                headless: env.BOT_HEADLESS !== "false",
                executablePath: env.CHROMIUM_EXECUTABLE_PATH,
                env: { ...process.env, PULSE_SINK: audio.sinkName },
                args: [...CHROMIUM_LAUNCH_ARGS]
              }),
              joinDeadline
            );
            await grantTeamsMediaPermissions(context, input.meetingUrl);
            const page = await context.newPage();
            activePage = page;
            await input.onLog?.({ level: "info", message: "Opening Teams meeting URL" });
            await page.goto(input.meetingUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs(env.BOT_JOIN_TIMEOUT_MS, 90_000), remainingJoinMs(joinDeadline)) });
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
          const bytes = await captureBrowserAudio(env, defaultAudioIo, audio.sinkName, {
            signal: input.abortSignal,
            stopWhen
          });
          return {
            bytes,
            contentType: contentTypeForFormat(env.BOT_RECORDING_FORMAT || "mp3"),
            joinMode: "guest"
          };
        } finally {
          input.abortSignal?.removeEventListener("abort", abortMeetingEndWatcher);
          meetingEndController.abort();
        }
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
    const page = await pageFactory();
    try {
      return await joinAsGuest(page, input, deadline);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableJoinError(lastError) || attempt >= maxAttempts) throw lastError;
      await onRetry?.(attempt, lastError);
    }
  }
  throw lastError ?? new Error("Teams guest join failed");
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
  let lastDiagnosticAt = Date.now();

  for (let attempt = 0; attempt < MEETING_NOT_STARTED_MAX_ATTEMPTS; attempt += 1) {
    checkJoinDeadline(deadline);
    await emitPrejoinDiagnosticIfDue(page, input, attempt + 1, lastDiagnosticAt).then((emitted) => {
      if (emitted) lastDiagnosticAt = Date.now();
    });
    await throwIfTeamsBlocker(page, mode, CONTROL_PROBE_TIMEOUT_MS);
    await clickTeamsWebEntry(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

    await turnOffMediaInputs(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);
    await dismissDevicePrompts(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

    filledName = (await fillAny(guestNameLocators(page), input.botName, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS)) || filledName;
    await turnOffMediaInputs(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);

    if (await clickAny(joinButtonLocators(page), CONTROL_PROBE_TIMEOUT_MS, 30_000, { suppressClickErrors: true })) {
      if (await hasJoinedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) return "joined";
      await input.onLog?.({ level: "info", message: "Clicked Teams join control; waiting for admission" });
      await input.onState?.("waiting_room");
      return waitForJoined(page, input, deadline, true);
    }

    if (filledName && !pressedEnter) {
      pressedEnter = await pressEnterFromPrejoin(page, CONTROL_PROBE_TIMEOUT_MS, CONTROL_ACTION_TIMEOUT_MS);
    }

    const stateAfterActions = await joinedOrLobbyState(page, CONTROL_PROBE_TIMEOUT_MS);
    if (stateAfterActions === "joined") return "joined";
    if (stateAfterActions === "waiting_room") {
      if (!sawLobby) {
        sawLobby = true;
        await input.onLog?.({ level: "info", message: "Waiting in Teams lobby" });
        await input.onState?.("waiting_room");
      }
      return waitForJoined(page, input, deadline, sawLobby);
    }

    await throwIfTeamsBlocker(page, mode, CONTROL_PROBE_TIMEOUT_MS);

    if (await hasMeetingNotStartedSignals(page, CONTROL_PROBE_TIMEOUT_MS)) {
      sawMeetingNotStarted = true;
      await waitForPoll(page, deadline);
      continue;
    }

    if (!sawMeetingNotStarted && attempt >= PREJOIN_MAX_ATTEMPTS - 1) break;
    await waitForPoll(page, deadline);
  }

  if (sawMeetingNotStarted) {
    await clickCancelJoinButton(page);
    throw new Error(`Teams meeting did not start before the bot wait window expired. ${await prejoinDiagnostic(page)}`);
  }
  const suffix = pressedEnter ? " after pressing Enter" : "";
  throw new TeamsJoinError(`Teams pre-join screen did not show a Join now button${suffix}. ${await prejoinDiagnostic(page)}`, true);
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
  if (sawMeetingNotStarted) {
    await clickCancelJoinButton(page);
    throw new Error(`Teams meeting did not start before the bot wait window expired. ${await prejoinDiagnostic(page)}`);
  }
  throw new Error("Teams did not confirm joined or waiting room state after Join now");
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
    await page.waitForTimeout(2_000).catch(() => undefined);
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
        throw new TeamsJoinError(`Microsoft login form detected. ${await prejoinDiagnostic(page)}`, false);
      }
      if (
        await scope
          .getByText(/sign in to join|join without signing in is not available|anonymous users.*(disabled|not allowed)|guest.*(disabled|not allowed)|ask your admin|not authorized|we need to verify your info|to join, sign in|sign in to teams|need to be signed in|due to org policy/i)
          .isVisible({ timeout })
          .catch(() => false)
      ) {
        throw new TeamsJoinError(`Teams guest join is blocked or requires sign-in. ${await prejoinDiagnostic(page)}`, false);
      }
    }
  }
  for (const scope of locatorScopes(page)) {
    if (await scope.getByText(/verify you(?:'|’)re a real person/i).isVisible({ timeout }).catch(() => false)) {
      throw new TeamsJoinError(`Teams blocked guest join with a captcha. ${await prejoinDiagnostic(page)}`, false);
    }
    if (await scope.getByText(/but you were denied access to the meeting|your request to join was declined/i).isVisible({ timeout }).catch(() => false)) {
      throw new TeamsJoinError(`Someone in the meeting denied the bot request to join. ${await prejoinDiagnostic(page)}`, false);
    }
    if (await scope.getByText(/we couldn(?:'|’)t connect you/i).isVisible({ timeout }).catch(() => false)) {
      throw new TeamsJoinError(`Teams could not connect the bot. ${await prejoinDiagnostic(page)}`, true);
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

async function captureBrowserAudio(
  env: RuntimeProcessEnv,
  io: AudioIo,
  sinkName: string,
  options: { signal?: AbortSignal; stopWhen?: Promise<unknown> } = {}
): Promise<Uint8Array> {
  const dir = await io.mkdtemp(join(tmpdir(), "minutesbot-recording-"));
  const file = join(dir, "recording.mp3");
  const seconds = Math.max(1, Number(env.BOT_RECORDING_SECONDS ?? env.BOT_RECORDING_MAX_SECONDS ?? "3600"));
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

function isRetryableJoinError(error: Error): boolean {
  return error instanceof TeamsJoinError ? error.retryable : true;
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
  captureBrowserAudio,
  chromiumLaunchArgs: CHROMIUM_LAUNCH_ARGS,
  createJoinDeadline,
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
