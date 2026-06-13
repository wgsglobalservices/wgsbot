import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertNoPlaceholders } from "./deploy-minutesbot";
import {
  ensureCloudflareResources,
  type CloudflareEnvironment,
  type EnsureCloudflareResourcesOptions,
  stripJsonComments,
  type RunCommand
} from "./ensure-cloudflare-resources";
import { applyReplacements, buildReplacements, currentAnswers, validateAnswers, type SetupAnswers } from "./setup-cloudflare";

type EnsureResources = (options: EnsureCloudflareResourcesOptions) => Promise<void>;

type BuildMinutesbotOptions = {
  env?: Record<string, string | undefined>;
  ensureResources?: EnsureResources;
  runBuildCommand?: RunCommand;
  readConfig?: (path: string) => Promise<string>;
  writeConfig?: (path: string, contents: string) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

const ROOT_CONFIG = "wrangler.jsonc";
const DEFAULT_WORKERS_BUILD_DOMAIN = "minutes.bot";

export async function buildMinutesbot(options: BuildMinutesbotOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const ensureResources = options.ensureResources ?? ensureCloudflareResources;
  const runBuildCommand = options.runBuildCommand ?? runInheritedCommand;
  const readConfig = options.readConfig ?? ((path: string) => readFile(path, "utf8"));
  const writeConfig = options.writeConfig ?? writeFile;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const environment = parseBuildEnvironment(env);

  if (env.WORKERS_CI === "1") {
    await prepareWorkersBuildConfig({ env, readConfig, writeConfig, log });
    log(`Workers Builds detected. Ensuring Cloudflare resources for ${environment}...`);
    await ensureResources({ environment, log, error });
    assertNoPlaceholders(await readConfig(ROOT_CONFIG));
  }

  await runBuildCommand("pnpm", ["run", "build:workspace"]);
}

export async function prepareWorkersBuildConfig(options: {
  env: Record<string, string | undefined>;
  readConfig: (path: string) => Promise<string>;
  writeConfig: (path: string, contents: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  const configText = await options.readConfig(ROOT_CONFIG);
  const current = currentAnswers(configText);
  const { answers, provided } = workersBuildAnswersFromEnv(options.env, current);
  validateAnswers(answers);

  const nextConfigText = applyReplacements(configText, buildReplacements(current, answers));
  assertNoWorkersBuildExampleDomains(nextConfigText, provided);

  if (nextConfigText !== configText) {
    await options.writeConfig(ROOT_CONFIG, nextConfigText);
    options.log(`Patched ${ROOT_CONFIG} for Cloudflare Workers Builds deployment.`);
  }
}

function workersBuildAnswersFromEnv(
  env: Record<string, string | undefined>,
  current: SetupAnswers
): { answers: SetupAnswers; provided: Set<string> } {
  const provided = new Set<string>();
  const value = (names: string[]): string | undefined => {
    for (const name of names) {
      const raw = env[name]?.trim();
      if (raw) {
        provided.add(names.join(" or "));
        return raw;
      }
    }
    return undefined;
  };

  const appDomain = hostnameOf(value(["APP_BASE_URL"]));
  const apiDomain = hostnameOf(value(["API_BASE_URL"]));
  const meetingDomain = hostnameOf(value(["BOT_WEBHOOK_BASE_URL"]));
  const meetingApiDomain = hostnameOf(value(["BOT_API_BASE_URL"]));
  const recorderEmail = value(["RECORDER_EMAIL", "DEFAULT_RECORDER_EMAIL"]);
  const defaultDomain = hostnameOf(value(["MINUTESBOT_DOMAIN"])) ?? DEFAULT_WORKERS_BUILD_DOMAIN;

  return {
    provided,
    answers: {
      appDomain: appDomain ?? defaultHostname(current.appDomain, "app", defaultDomain),
      apiDomain: apiDomain ?? defaultHostname(current.apiDomain, "api", defaultDomain),
      meetingDomain: meetingDomain ?? defaultHostname(current.meetingDomain, "meeting", defaultDomain),
      meetingApiDomain: meetingApiDomain ?? defaultHostname(current.meetingApiDomain, "meeting-api", defaultDomain),
      recorderEmail: recorderEmail ?? defaultRecorderEmail(current.recorderEmail, defaultDomain)
    }
  };
}

function defaultHostname(current: string, subdomain: string, domain: string): string {
  return current.endsWith(".example.com") ? `${subdomain}.${domain}` : current;
}

function defaultRecorderEmail(current: string, domain: string): string {
  return current.endsWith("@example.com") ? `notetaker@${domain}` : current;
}

function assertNoWorkersBuildExampleDomains(configText: string, provided: Set<string>): void {
  const remaining = [...new Set(stripJsonComments(configText).match(/[a-z0-9.-]*example\.com/gi) ?? [])];
  if (remaining.length === 0) return;

  const required = [
    `MINUTESBOT_DOMAIN=${DEFAULT_WORKERS_BUILD_DOMAIN}`,
    "APP_BASE_URL=https://app.your-zone.com",
    "API_BASE_URL=https://api.your-zone.com",
    "BOT_WEBHOOK_BASE_URL=https://meeting.your-zone.com",
    "BOT_API_BASE_URL=https://meeting-api.your-zone.com",
    "RECORDER_EMAIL=notetaker@your-zone.com (or DEFAULT_RECORDER_EMAIL)"
  ];
  const supplied = provided.size > 0 ? ` Supplied: ${[...provided].join(", ")}.` : "";
  throw new Error(
    `Cloudflare Workers Builds cannot deploy the checked-in example.com routes. Remaining placeholders: ${remaining.join(
      ", "
    )}. Set these build environment variables in Cloudflare: ${required.join(", ")}.${supplied}`
  );
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname;
  } catch {
    return undefined;
  }
}

export function parseBuildEnvironment(env: Record<string, string | undefined>): CloudflareEnvironment {
  const value = env.MINUTESBOT_DEPLOY_ENV ?? "production";
  if (value === "production" || value === "staging") return value;
  throw new Error(`Unsupported build deploy environment "${value}". Use "production" or "staging".`);
}

async function runInheritedCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  buildMinutesbot().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
