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
    locatorScopes(page).flatMap((scope) => [
      scope.getByRole("button", { name: /continue on this browser|join on the web|use the web app|continue without audio or video/i }),
      scope.getByRole("link", { name: /continue on this browser|join on the web|use the web app/i }),
      scope.getByText(/continue on this browser|join on the web|use the web app/i)
    ]),
    20_000
  );
  if (!clicked) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined);
}

async function fillGuestName(page: any, botName: string): Promise<boolean> {
  return fillAny(guestNameLocators(page), botName, 20_000);
}

async function joinFromPrejoin(page: any, botName: string): Promise<"waiting_room" | "joined"> {
  await dismissDevicePrompts(page);
  const filledName = await fillAny(guestNameLocators(page), botName, 1_000);
  const clickedJoin = await clickAny(joinButtonLocators(page), 30_000);
  if (!clickedJoin && filledName) {
    const pressedEnter = await pressEnterFromPrejoin(page);
    if (pressedEnter) {
      try {
        return await waitForJoinedOrLobby(page);
      } catch {
        throw new Error(`Teams pre-join screen did not show a Join now button after pressing Enter. ${await prejoinDiagnostic(page)}`);
      }
    }
  }
  if (!clickedJoin) throw new Error(`Teams pre-join screen did not show a Join now button. ${await prejoinDiagnostic(page)}`);
  return waitForJoinedOrLobby(page);
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

async function dismissDevicePrompts(page: any): Promise<void> {
  await clickAny(locatorScopes(page).map((scope) => scope.getByRole("button", { name: /continue without audio or video/i })), 3_000);
  for (const scope of locatorScopes(page)) {
    for (const label of [/microphone/i, /camera/i]) {
      const toggle = scope.getByRole("switch", { name: label });
      const checked = await toggle.isChecked({ timeout: 1_000 }).catch(() => false);
      if (checked) await toggle.click({ timeout: 1_000 }).catch(() => undefined);
    }
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
  for (const scope of locatorScopes(page)) {
    if (await scope.getByRole("button", { name: /leave|hang up/i }).isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByRole("button", { name: /people|participants|chat/i }).isVisible({ timeout }).catch(() => false)) return true;
    if (await scope.getByText(/you(?:'|’)re the only one here|meeting chat|participants/i).isVisible({ timeout }).catch(() => false)) return true;
  }
  return false;
}

async function hasLobbySignals(page: any, timeout: number): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    if (await scope.getByText(/someone.*let you in|waiting.*lobby|you(?:'|’)re in the lobby|when the meeting starts/i).isVisible({ timeout }).catch(() => false)) {
      return true;
    }
    if (await scope.getByText(/ask to join|admit/i).isVisible({ timeout }).catch(() => false)) return true;
  }
  return false;
}

async function pressEnterFromPrejoin(page: any): Promise<boolean> {
  for (const scope of locatorScopes(page)) {
    for (const target of guestNameLocatorsForScope(scope)) {
      if (await target.first().isVisible({ timeout: 500 }).catch(() => false)) {
        await target.first().press("Enter", { timeout: 1_000 }).catch(() => undefined);
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
  const snippets = Array.isArray(visibleControls)
    ? visibleControls.map((control) => compactControl(control as Record<string, string>)).filter(Boolean).slice(0, 8)
    : [];
  const counts = await selectorCounts(scope, [...guestNameSelectors(), ...joinButtonSelectors()]);
  return `scope${index}{url=${url || "unknown"} counts=${counts.join(",")} controls=${snippets.join(";") || "none"}}`;
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
