import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  ensureCloudflareResources,
  errorMessage,
  runWrangler,
  stripJsonComments,
  type EnsureCloudflareResourcesOptions,
  type RunCommand
} from "./ensure-cloudflare-resources";

const ROOT_CONFIG = "wrangler.jsonc";
const BOT_CONFIG = "deploy/bot-container/wrangler.jsonc";

const HOSTNAME_PATTERN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SetupAnswers = {
  appDomain: string;
  apiDomain: string;
  meetingDomain: string;
  meetingApiDomain: string;
  recorderEmail: string;
};

type EnsureResources = (options: EnsureCloudflareResourcesOptions) => Promise<void>;

type SetupCloudflareOptions = {
  args?: string[];
  env?: Record<string, string | undefined>;
  dryRun?: boolean;
  nonInteractive?: boolean;
  skipEnsure?: boolean;
  runCommand?: RunCommand;
  ensureResources?: EnsureResources;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
  prompt?: (question: string, fallback: string) => Promise<string>;
  isInteractive?: boolean;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * First-time setup: validates prerequisites, collects the operator's domains
 * and recorder email (flags, .env, or interactive prompts), patches both
 * wrangler configs in place, creates-or-verifies the Cloudflare resources,
 * and prints the secrets and Email Routing steps that remain manual.
 */
export async function setupCloudflare(options: SetupCloudflareOptions = {}): Promise<void> {
  const args = options.args ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runWrangler;
  const ensureResources = options.ensureResources ?? ensureCloudflareResources;
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const writeTextFile = options.writeTextFile ?? ((path: string, contents: string) => writeFile(path, contents));
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const dryRun = options.dryRun ?? args.includes("--dry-run");
  const nonInteractive = options.nonInteractive ?? (args.includes("--non-interactive") || args.includes("--yes"));
  const skipEnsure = options.skipEnsure ?? args.includes("--skip-ensure");

  await validatePrerequisites(runCommand, log, error);

  const rootText = await readTextFile(ROOT_CONFIG);
  const botText = await readTextFile(BOT_CONFIG);
  const current = currentAnswers(rootText);
  const envFileDefaults = await envFileAnswers(readTextFile, env);

  const interactive = options.isInteractive ?? (process.stdin.isTTY === true && !nonInteractive);
  const prompt = options.prompt ?? defaultPrompt;
  const answers = await resolveAnswers({ args, current, envFileDefaults, interactive, prompt });
  validateAnswers(answers);

  const replacements = buildReplacements(current, answers);
  const nextRootText = applyReplacements(rootText, replacements);
  const nextBotText = applyReplacements(botText, replacements);

  if (replacements.length === 0) {
    log("Domains and recorder email already match; no config changes needed.");
  } else {
    for (const [from, to] of replacements) log(`${dryRun ? "Would replace" : "Replacing"} ${from} -> ${to}`);
  }

  if (!dryRun) {
    if (nextRootText !== rootText) await writeTextFile(ROOT_CONFIG, nextRootText);
    if (nextBotText !== botText) await writeTextFile(BOT_CONFIG, nextBotText);
  }

  if (!skipEnsure) {
    await ensureResources({
      environment: "production",
      dryRun,
      runCommand,
      readConfig: async (path) => (path === ROOT_CONFIG && dryRun ? nextRootText : readTextFile(path)),
      log,
      error
    });
  }

  printNextSteps(log, answers);
}

async function validatePrerequisites(runCommand: RunCommand, log: (m: string) => void, error: (m: string) => void): Promise<void> {
  const required: Array<{ name: string; command: string; args: string[]; hint: string }> = [
    { name: "pnpm", command: "pnpm", args: ["--version"], hint: "Install pnpm (https://pnpm.io)." },
    { name: "wrangler", command: "wrangler", args: ["--version"], hint: "Run pnpm install; wrangler is a dev dependency." },
    {
      name: "wrangler auth",
      command: "wrangler",
      args: ["whoami"],
      hint: "Run `wrangler login` or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID."
    }
  ];
  for (const check of required) {
    try {
      await runCommand(check.command, check.args);
      log(`OK ${check.name}`);
    } catch (cause) {
      error(`Missing prerequisite: ${check.name}. ${check.hint}`);
      throw new Error(`Prerequisite check failed for ${check.name}: ${errorMessage(cause)}`);
    }
  }
  try {
    await runCommand("docker", ["--version"]);
    log("OK docker");
  } catch {
    log("WARNING: docker not found. It is required later for `pnpm bot:deploy` (container image build), not for this setup.");
  }
}

export function currentAnswers(rootText: string): SetupAnswers {
  const config = JSON.parse(stripJsonComments(rootText)) as { vars?: Record<string, string> };
  const vars = config.vars ?? {};
  return {
    appDomain: hostnameOf(vars.APP_BASE_URL) ?? "app.example.com",
    apiDomain: hostnameOf(vars.API_BASE_URL) ?? "api.example.com",
    meetingDomain: hostnameOf(vars.BOT_WEBHOOK_BASE_URL) ?? "meeting.example.com",
    meetingApiDomain: hostnameOf(vars.BOT_API_BASE_URL) ?? "meeting-api.example.com",
    recorderEmail: vars.DEFAULT_RECORDER_EMAIL ?? "notetaker@example.com"
  };
}

async function envFileAnswers(
  readTextFile: (path: string) => Promise<string>,
  env: Record<string, string | undefined>
): Promise<Partial<SetupAnswers>> {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnvFile(await readTextFile(".env"));
  } catch {
    // .env is optional.
  }
  const merged = { ...fileEnv, ...env };
  return {
    appDomain: hostnameOf(merged.APP_BASE_URL),
    apiDomain: hostnameOf(merged.API_BASE_URL),
    meetingDomain: hostnameOf(merged.BOT_WEBHOOK_BASE_URL),
    meetingApiDomain: hostnameOf(merged.BOT_API_BASE_URL),
    recorderEmail: merged.RECORDER_EMAIL?.trim() || undefined
  };
}

export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

async function resolveAnswers(options: {
  args: string[];
  current: SetupAnswers;
  envFileDefaults: Partial<SetupAnswers>;
  interactive: boolean;
  prompt: (question: string, fallback: string) => Promise<string>;
}): Promise<SetupAnswers> {
  const flag = (name: string) => {
    const index = options.args.indexOf(name);
    return index >= 0 ? options.args[index + 1] : undefined;
  };
  const fields: Array<{ key: keyof SetupAnswers; flagName: string; question: string }> = [
    { key: "appDomain", flagName: "--app-domain", question: "Admin UI hostname (admin SPA + APP_BASE_URL)" },
    { key: "apiDomain", flagName: "--api-domain", question: "API hostname (API_BASE_URL)" },
    { key: "meetingDomain", flagName: "--meeting-domain", question: "Bot webhook hostname (BOT_WEBHOOK_BASE_URL)" },
    { key: "meetingApiDomain", flagName: "--meeting-api-domain", question: "Bot runtime API hostname (BOT_API_BASE_URL, separate worker)" },
    { key: "recorderEmail", flagName: "--recorder-email", question: "Recorder mailbox address (receives Teams invites)" }
  ];

  const answers = { ...options.current };
  for (const field of fields) {
    const fromFlag = flag(field.flagName);
    const fallback = options.envFileDefaults[field.key] ?? options.current[field.key];
    if (fromFlag) {
      answers[field.key] = fromFlag.trim();
    } else if (options.interactive) {
      answers[field.key] = (await options.prompt(field.question, fallback)).trim() || fallback;
    } else {
      answers[field.key] = fallback;
    }
  }
  return answers;
}

export function validateAnswers(answers: SetupAnswers): void {
  const hostFields: Array<[string, string]> = [
    ["--app-domain", answers.appDomain],
    ["--api-domain", answers.apiDomain],
    ["--meeting-domain", answers.meetingDomain],
    ["--meeting-api-domain", answers.meetingApiDomain]
  ];
  for (const [flagName, value] of hostFields) {
    if (!HOSTNAME_PATTERN.test(value)) {
      throw new Error(`${flagName} must be a bare hostname like app.yourcompany.com (got "${value}").`);
    }
  }
  if (!EMAIL_PATTERN.test(answers.recorderEmail)) {
    throw new Error(`--recorder-email must be an email address (got "${answers.recorderEmail}").`);
  }
  const hosts = hostFields.map(([, value]) => value.toLowerCase());
  if (new Set(hosts).size !== hosts.length) {
    throw new Error("Each hostname must be unique; the bot runtime worker cannot share a custom domain with the main worker.");
  }
}

export function buildReplacements(current: SetupAnswers, next: SetupAnswers): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    [current.appDomain, next.appDomain],
    [current.apiDomain, next.apiDomain],
    [current.meetingDomain, next.meetingDomain],
    [current.meetingApiDomain, next.meetingApiDomain],
    [current.recorderEmail, next.recorderEmail]
  ];
  // Longest first so api.example.com cannot match inside meeting-api.example.com.
  return pairs.filter(([from, to]) => from !== to).sort((a, b) => b[0].length - a[0].length);
}

/** Boundary-safe text substitution so substring hostnames never collide. */
export function applyReplacements(text: string, replacements: Array<[string, string]>): string {
  let result = text;
  for (const [from, to] of replacements) {
    const pattern = new RegExp(`(?<![A-Za-z0-9.-])${escapeRegExp(from)}(?![A-Za-z0-9-])`, "g");
    result = result.replace(pattern, to);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return undefined;
  }
}

async function defaultPrompt(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} [${fallback}]: `)).trim();
  } finally {
    rl.close();
  }
}

function printNextSteps(log: (message: string) => void, answers: SetupAnswers): void {
  log("");
  log("Secrets (set with wrangler; values are never stored in source, .env, or D1):");
  log("  wrangler secret put AI_API_KEY            # OpenAI(-compatible) key for recap generation; also used for Whisper unless TRANSCRIPTION_API_KEY is set");
  log("  wrangler secret put TRANSCRIPTION_API_KEY # optional: separate key for the transcription provider");
  log("  wrangler secret put SESSION_SECRET        # only for admin-token auth mode (ALLOW_ADMIN_TOKEN_AUTH=true)");
  log("  BOT_INTERNAL_TOKEN is generated and pushed to both workers automatically by `pnpm bot:deploy`.");
  log("");
  log("Manual Cloudflare dashboard steps:");
  log(`  1. Email Routing: route ${answers.recorderEmail} to the minutesbot Worker (Email Workers rule) and verify the sender address.`);
  log(`  2. Cloudflare Access (recommended): protect https://${answers.appDomain} and set CLOUDFLARE_ACCESS_AUD / CLOUDFLARE_ACCESS_JWKS_URL / CLOUDFLARE_ACCESS_ISSUER vars.`);
  log("");
  log("Then deploy:");
  log("  pnpm deploy      # main worker (migrations, build, deploy, smoke checks)");
  log("  pnpm bot:deploy  # bot container worker (Docker build + BOT_INTERNAL_TOKEN provisioning)");
  log("  pnpm check       # health checks");
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  setupCloudflare().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
