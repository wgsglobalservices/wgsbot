import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "../packages/shared/src/json";
import {
  ensureCloudflareResources,
  runWrangler,
  type CloudflareEnvironment,
  type RequiredCloudflareResources,
  type RunCommand
} from "./ensure-cloudflare-resources";
import { verifyAttendeeHealth } from "./deploy-attendee";

export type RunCommandWithInput = (command: string, args: string[], input: string) => Promise<string | void>;

type OneshotDeployOptions = {
  environment?: CloudflareEnvironment;
  envFilePath?: string;
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  runCommand?: RunCommand;
  runCommandWithInput?: RunCommandWithInput;
  fetchHealth?: typeof fetch;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
  makeDir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type OneshotEnv = Record<string, string>;

const GENERATED_MINUTESBOT_CONFIG = ".wrangler/oneshot-minutesbot.jsonc";
const GENERATED_ATTENDEE_CONFIG = ".wrangler/oneshot-attendee.jsonc";
const WORKER_CUSTOM_DOMAIN = "app.minutes.bot";
const EXPECTED_APP_BASE_DOMAIN = "admin.minutes.bot";
const EXPECTED_API_BASE_DOMAIN = "api.minutes.bot";
const EXPECTED_ATTENDEE_WEBHOOK_DOMAIN = "admin.minutes.bot";

const REQUIRED_ENV_KEYS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ENV",
  "APP_BASE_URL",
  "API_BASE_URL",
  "ATTENDEE_WEBHOOK_BASE_URL",
  "ATTENDEE_API_BASE_URL",
  "ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME",
  "DEFAULT_RECORDER_EMAIL",
  "DEFAULT_SENDER_EMAIL",
  "DATABASE_URL",
  "REDIS_URL",
  "DJANGO_SECRET_KEY",
  "CREDENTIALS_ENCRYPTION_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_ENDPOINT_URL",
  "R2_RECORDING_BUCKET_NAME",
  "ATTENDEE_API_KEY",
  "ATTENDEE_WEBHOOK_SECRET",
  "DEEPGRAM_API_KEY",
  "OPENROUTER_API_KEY",
  "SESSION_SECRET",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET"
] as const;

export async function deployOneshot(options: OneshotDeployOptions = {}): Promise<void> {
  const environment = options.environment ?? "production";
  const dryRun = options.dryRun ?? false;
  const runCommand = options.runCommand ?? runWrangler;
  const runCommandWithInput = options.runCommandWithInput ?? runWithInput;
  const fetchHealth = options.fetchHealth ?? fetch;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const env = await loadOneshotEnv(options);

  validateOneshotEnv(env, environment);

  const minutesbotConfig = buildMinutesbotWranglerConfig(env, environment);
  const attendeeConfig = buildAttendeeWranglerConfig(env);
  const resources = resourceNames(environment, env);

  await validatePrerequisites({ runCommand, dryRun, log });
  await writeGeneratedConfig(GENERATED_MINUTESBOT_CONFIG, minutesbotConfig, options, dryRun, log);
  await writeGeneratedConfig(GENERATED_ATTENDEE_CONFIG, attendeeConfig, options, dryRun, log);

  await runOrLog(dryRun, log, "ensure Cloudflare resources", async () => {
    await ensureCloudflareResources({
      environment,
      configPath: GENERATED_MINUTESBOT_CONFIG,
      resources,
      runCommand,
      readConfig: options.readTextFile,
      writeConfig: options.writeTextFile,
      log,
      error
    });
  });

  await runOrLog(dryRun, log, "prepare upstream Attendee checkout", async () => {
    await runCommand("pnpm", ["attendee:prepare"]);
  });

  await putSecrets({
    label: "Attendee container",
    configPath: GENERATED_ATTENDEE_CONFIG,
    secrets: attendeeSecrets(env),
    dryRun,
    runCommandWithInput,
    log
  });

  await runOrLog(dryRun, log, "deploy Attendee container Worker", async () => {
    await runCommand("wrangler", ["deploy", "--config", GENERATED_ATTENDEE_CONFIG]);
  });

  await runOrLog(dryRun, log, "check Attendee health", async () => {
    await verifyAttendeeHealth({ baseUrl: env.ATTENDEE_API_BASE_URL, fetchHealth, log, error });
  });

  await runOrLog(dryRun, log, "start Attendee background containers", async () => {
    await postJson(fetchHealth, `${trimUrl(env.ATTENDEE_API_BASE_URL)}/_ops/start-workers`);
  });

  await putSecrets({
    label: "minutesbot",
    configPath: GENERATED_MINUTESBOT_CONFIG,
    secrets: minutesbotSecrets(env),
    dryRun,
    runCommandWithInput,
    log
  });

  await runOrLog(dryRun, log, "build minutesbot web and worker bundles", async () => {
    await runCommand("pnpm", ["run", "build"]);
  });

  await runOrLog(dryRun, log, "deploy minutesbot Worker", async () => {
    await runCommand("wrangler", ["deploy", "--config", GENERATED_MINUTESBOT_CONFIG]);
  });

  await runSmokeChecks({ env, dryRun, fetchHealth, log });
}

export function parseOneshotArgs(args: string[]): { environment: CloudflareEnvironment; dryRun: boolean; envFilePath?: string } {
  const envFlagIndex = args.indexOf("--env");
  const environment = envFlagIndex >= 0 ? args[envFlagIndex + 1] : "production";
  if (environment !== "production" && environment !== "staging") {
    throw new Error(`Unsupported oneshot deploy environment "${environment}". Use "production" or "staging".`);
  }

  const envFileIndex = args.indexOf("--env-file");
  return {
    environment,
    dryRun: args.includes("--dry-run"),
    envFilePath: envFileIndex >= 0 ? args[envFileIndex + 1] : undefined
  };
}

export function parseEnvFile(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    parsed[key] = unquote(value);
  }
  return parsed;
}

export function validateOneshotEnv(env: Record<string, string | undefined>, environment: CloudflareEnvironment): asserts env is OneshotEnv {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required .env.oneshot values: ${missing.join(", ")}`);
  }
  if (env.CLOUDFLARE_ENV !== environment) {
    throw new Error(`CLOUDFLARE_ENV must match --env. Got "${env.CLOUDFLARE_ENV}" and "${environment}".`);
  }
  for (const key of ["APP_BASE_URL", "API_BASE_URL", "ATTENDEE_WEBHOOK_BASE_URL", "ATTENDEE_API_BASE_URL", "R2_ENDPOINT_URL"] as const) {
    assertUrl(key, env[key] ?? "");
  }
  assertUrlHostname("APP_BASE_URL", env.APP_BASE_URL ?? "", EXPECTED_APP_BASE_DOMAIN);
  assertUrlHostname("API_BASE_URL", env.API_BASE_URL ?? "", EXPECTED_API_BASE_DOMAIN);
  assertUrlHostname("ATTENDEE_WEBHOOK_BASE_URL", env.ATTENDEE_WEBHOOK_BASE_URL ?? "", EXPECTED_ATTENDEE_WEBHOOK_DOMAIN);
  for (const key of ["DEFAULT_RECORDER_EMAIL", "DEFAULT_SENDER_EMAIL"] as const) {
    if (!(env[key] ?? "").includes("@")) throw new Error(`${key} must be an email address.`);
  }
}

export function buildMinutesbotWranglerConfig(env: OneshotEnv, environment: CloudflareEnvironment): string {
  const resources = resourceNames(environment, env);
  return stringifyConfig({
    $schema: "../node_modules/wrangler/config-schema.json",
    name: workerName("minutesbot", environment),
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    main: "../apps/api-worker/src/index.ts",
    assets: {
      directory: "../apps/web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true
    },
    workers_dev: false,
    routes: [{ pattern: WORKER_CUSTOM_DOMAIN, custom_domain: true }],
    compatibility_date: "2026-05-04",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, head_sampling_rate: 1 },
    vars: {
      APP_BASE_URL: env.APP_BASE_URL,
      API_BASE_URL: env.API_BASE_URL,
      ATTENDEE_WEBHOOK_BASE_URL: env.ATTENDEE_WEBHOOK_BASE_URL,
      ATTENDEE_API_BASE_URL: env.ATTENDEE_API_BASE_URL,
      ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME: env.ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME,
      DEFAULT_RECORDER_EMAIL: env.DEFAULT_RECORDER_EMAIL,
      DEFAULT_SENDER_EMAIL: env.DEFAULT_SENDER_EMAIL,
      ENVIRONMENT: environment,
      ...optionalCloudflareAccessVars(env)
    },
    d1_databases: [{ binding: resources.d1.binding, database_name: resources.d1.databaseName, database_id: "replace-with-d1-database-id" }],
    r2_buckets: [{ binding: "ARTIFACTS", bucket_name: env.ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME }],
    queues: queueConfig(resources.queues),
    workflows: [
      { name: scopedName("minutesbot-meeting-workflow", environment), binding: "MEETING_WORKFLOW", class_name: "MeetingWorkflow" },
      { name: scopedName("minutesbot-transcript-workflow", environment), binding: "TRANSCRIPT_WORKFLOW", class_name: "TranscriptWorkflow" },
      { name: scopedName("minutesbot-summary-workflow", environment), binding: "SUMMARY_WORKFLOW", class_name: "SummaryWorkflow" },
      { name: scopedName("minutesbot-cleanup-workflow", environment), binding: "CLEANUP_WORKFLOW", class_name: "CleanupWorkflow" }
    ],
    send_email: [{ name: "SEND_EMAIL", allowed_sender_addresses: [env.DEFAULT_SENDER_EMAIL] }]
  });
}

export function buildAttendeeWranglerConfig(env: OneshotEnv): string {
  return stringifyConfig({
    $schema: "../node_modules/wrangler/config-schema.json",
    name: "minutesbot-attendee",
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    main: "../deploy/attendee-container/src/index.ts",
    compatibility_date: "2026-05-04",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, head_sampling_rate: 1 },
    workers_dev: false,
    routes: uniqueRoutes([env.ATTENDEE_API_BASE_URL]),
    vars: {
      DJANGO_SETTINGS_MODULE: "attendee.settings.production",
      ATTENDEE_WEB_INSTANCES: "1",
      ATTENDEE_CONTAINER_SLEEP_AFTER: "24h"
    },
    containers: [
      { class_name: "AttendeeWebContainer", image: "../.attendee/upstream/Dockerfile", max_instances: 2, instance_type: "standard-2" },
      { class_name: "AttendeeWorkerContainer", image: "../.attendee/upstream/Dockerfile", max_instances: 1, instance_type: "standard-2" },
      { class_name: "AttendeeSchedulerContainer", image: "../.attendee/upstream/Dockerfile", max_instances: 1, instance_type: "basic" }
    ],
    durable_objects: {
      bindings: [
        { name: "ATTENDEE_WEB", class_name: "AttendeeWebContainer" },
        { name: "ATTENDEE_WORKER", class_name: "AttendeeWorkerContainer" },
        { name: "ATTENDEE_SCHEDULER", class_name: "AttendeeSchedulerContainer" }
      ]
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["AttendeeWebContainer", "AttendeeWorkerContainer", "AttendeeSchedulerContainer"] }],
    triggers: { crons: ["*/30 * * * *"] }
  });
}

async function loadOneshotEnv(options: OneshotDeployOptions): Promise<Record<string, string | undefined>> {
  if (options.env) return options.env;
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const envFilePath = options.envFilePath ?? ".env.oneshot";
  const fileEnv = parseEnvFile(await readTextFile(envFilePath));
  return { ...fileEnv, ...process.env };
}

async function validatePrerequisites(options: { runCommand: RunCommand; dryRun: boolean; log: (message: string) => void }): Promise<void> {
  await runOrLog(options.dryRun, options.log, "validate pnpm", () => options.runCommand("pnpm", ["--version"]));
  await runOrLog(options.dryRun, options.log, "validate Wrangler auth", () => options.runCommand("wrangler", ["whoami"]));
  await runOrLog(options.dryRun, options.log, "validate Docker daemon", () => options.runCommand("docker", ["info"]));
}

async function writeGeneratedConfig(
  path: string,
  contents: string,
  options: OneshotDeployOptions,
  dryRun: boolean,
  log: (message: string) => void
): Promise<void> {
  if (dryRun) {
    log(`[dry-run] write ${path}`);
    return;
  }
  const makeDir = options.makeDir ?? mkdir;
  const writeTextFile = options.writeTextFile ?? writeFile;
  await makeDir(dirname(path), { recursive: true });
  await writeTextFile(path, contents);
}

async function putSecrets(options: {
  label: string;
  configPath: string;
  secrets: Record<string, string>;
  dryRun: boolean;
  runCommandWithInput: RunCommandWithInput;
  log: (message: string) => void;
}): Promise<void> {
  for (const [name, value] of Object.entries(options.secrets)) {
    await runOrLog(options.dryRun, options.log, `put ${options.label} secret ${name}`, async () => {
      await options.runCommandWithInput("wrangler", ["secret", "put", name, "--config", options.configPath], `${value}\n`);
    });
  }
}

function attendeeSecrets(env: OneshotEnv): Record<string, string> {
  return {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    DJANGO_SECRET_KEY: env.DJANGO_SECRET_KEY,
    CREDENTIALS_ENCRYPTION_KEY: env.CREDENTIALS_ENCRYPTION_KEY,
    AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    AWS_ENDPOINT_URL: env.R2_ENDPOINT_URL,
    AWS_RECORDING_STORAGE_BUCKET_NAME: env.R2_RECORDING_BUCKET_NAME,
    DEEPGRAM_API_KEY: env.DEEPGRAM_API_KEY,
    OPENAI_API_KEY: env.OPENROUTER_API_KEY,
    OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
    ZOOM_CLIENT_ID: env.ZOOM_CLIENT_ID,
    ZOOM_CLIENT_SECRET: env.ZOOM_CLIENT_SECRET
  };
}

function minutesbotSecrets(env: OneshotEnv): Record<string, string> {
  return {
    ATTENDEE_API_KEY: env.ATTENDEE_API_KEY,
    ATTENDEE_WEBHOOK_SECRET: env.ATTENDEE_WEBHOOK_SECRET,
    AI_API_KEY: env.OPENROUTER_API_KEY,
    SESSION_SECRET: env.SESSION_SECRET
  };
}

function optionalCloudflareAccessVars(env: OneshotEnv): Record<string, string> {
  return Object.fromEntries(
    ["CLOUDFLARE_ACCESS_AUD", "CLOUDFLARE_ACCESS_JWKS_URL", "CLOUDFLARE_ACCESS_ISSUER"]
      .map((key) => [key, env[key]])
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

async function runSmokeChecks(options: {
  env: OneshotEnv;
  dryRun: boolean;
  fetchHealth: typeof fetch;
  log: (message: string) => void;
}): Promise<void> {
  await runOrLog(options.dryRun, options.log, "smoke check minutesbot API health", async () => {
    await getOk(options.fetchHealth, `${trimUrl(options.env.API_BASE_URL)}/api/health`);
  });
  await runOrLog(options.dryRun, options.log, "smoke check R2 binding", async () => {
    await postJson(options.fetchHealth, `${trimUrl(options.env.API_BASE_URL)}/api/admin/test-r2`, options.env.SESSION_SECRET);
  });
  await runOrLog(options.dryRun, options.log, "smoke check Attendee API auth", async () => {
    await postJson(options.fetchHealth, `${trimUrl(options.env.API_BASE_URL)}/api/admin/test-attendee`, options.env.SESSION_SECRET);
  });
  await runOrLog(options.dryRun, options.log, "smoke check signed Attendee webhook", async () => {
    const payload = {
      idempotency_key: `oneshot-smoke-${Date.now()}`,
      bot_id: "minutesbot-oneshot-smoke",
      trigger: "bot.state_change",
      data: { event_type: "smoke_check", new_state: "ended" }
    };
    const rawBody = stableStringify(payload);
    const signature = await signWebhook(rawBody, options.env.ATTENDEE_WEBHOOK_SECRET);
    await postJson(options.fetchHealth, `${trimUrl(options.env.ATTENDEE_WEBHOOK_BASE_URL)}/api/webhooks/attendee`, undefined, rawBody, {
      "x-webhook-signature": signature
    });
  });
}

async function getOk(fetcher: typeof fetch, url: string): Promise<void> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
}

async function postJson(
  fetcher: typeof fetch,
  url: string,
  bearerToken?: string,
  body = "{}",
  headers: Record<string, string> = {}
): Promise<void> {
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      ...headers
    },
    body
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
}

async function signWebhook(rawBody: string, webhookSecretBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", Buffer.from(webhookSecretBase64, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return Buffer.from(digest).toString("base64");
}

async function runOrLog<T>(dryRun: boolean, log: (message: string) => void, label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (dryRun) {
    log(`[dry-run] ${label}`);
    return undefined;
  }
  log(label);
  return await fn();
}

function resourceNames(environment: CloudflareEnvironment, env: OneshotEnv): RequiredCloudflareResources {
  const suffix = environment === "production" ? "" : `-${environment}`;
  return {
    d1: { binding: "DB", databaseName: `minutesbot${suffix}` },
    r2Buckets: [env.ATTENDEE_EXTERNAL_MEDIA_BUCKET_NAME],
    queues: [`minutesbot${suffix}-invites`, `minutesbot${suffix}-summaries`, `minutesbot${suffix}-email`]
  };
}

function queueConfig(queues: string[]) {
  return {
    producers: [
      { binding: "INVITE_QUEUE", queue: queues[0] },
      { binding: "SUMMARY_QUEUE", queue: queues[1] },
      { binding: "EMAIL_QUEUE", queue: queues[2] }
    ]
  };
}

function uniqueRoutes(urls: string[]): Array<{ pattern: string; custom_domain: true }> {
  return Array.from(new Set(urls.map((value) => new URL(value).hostname))).map((pattern) => ({ pattern, custom_domain: true }));
}

function workerName(base: string, environment: CloudflareEnvironment): string {
  return environment === "production" ? base : `${base}-${environment}`;
}

function scopedName(base: string, environment: CloudflareEnvironment): string {
  return environment === "production" ? base : `${base}-${environment}`;
}

function stringifyConfig(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function trimUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertUrl(key: string, value: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL.`);
  }
}

function assertUrlHostname(key: string, value: string, expectedHostname: string): void {
  if (new URL(value).hostname !== expectedHostname) {
    throw new Error(`${key} must use ${expectedHostname}.`);
  }
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

async function runWithInput(command: string, args: string[], input: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}${stderr}`.trim()));
    });
    child.stdin.end(input);
  });
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  const parsed = parseOneshotArgs(process.argv);
  deployOneshot(parsed).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
