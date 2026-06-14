import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type CloudflareEnvironment = "development" | "production" | "staging";

export type RequiredCloudflareResources = {
  d1: { binding: string; databaseName: string };
  r2Buckets: string[];
  queues: string[];
};

// Source of truth for the Cloudflare resources each environment needs. The
// names must match the bindings in the root wrangler.jsonc (queue
// producer/consumer JOBS_QUEUE, R2 binding ARTIFACTS, D1 binding DB).
const REQUIRED_RESOURCES: Record<CloudflareEnvironment, RequiredCloudflareResources> = {
  development: {
    d1: { binding: "DB", databaseName: "minutesbot" },
    r2Buckets: ["minutesbot-artifacts"],
    queues: ["minutesbot-jobs", "minutesbot-dlq"]
  },
  production: {
    d1: { binding: "DB", databaseName: "minutesbot" },
    r2Buckets: ["minutesbot-artifacts"],
    queues: ["minutesbot-jobs", "minutesbot-dlq"]
  },
  staging: {
    d1: { binding: "DB", databaseName: "minutesbot-staging" },
    r2Buckets: ["minutesbot-staging-artifacts"],
    queues: ["minutesbot-staging-jobs", "minutesbot-staging-dlq"]
  }
};

export type RunCommand = (command: string, args: string[], options?: { input?: string }) => Promise<string | void>;

export type EnsureCloudflareResourcesOptions = {
  environment?: CloudflareEnvironment;
  configPath?: string;
  dryRun?: boolean;
  runCommand?: RunCommand;
  readConfig?: (path: string) => Promise<string>;
  writeConfig?: (path: string, contents: string) => Promise<void>;
  resources?: RequiredCloudflareResources;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

class CommandError extends Error {
  constructor(
    message: string,
    readonly output: string
  ) {
    super(message);
  }
}

function isMissingResourceError(error: unknown): boolean {
  const message = error instanceof CommandError ? `${error.message}\n${error.output}` : error instanceof Error ? error.message : String(error);
  // Best effort: "not found"-style text also shows up in auth and network failures, so only
  // treat the resource as missing when the output does not look like an auth/network error.
  if (/authentication|fetch failed/i.test(message)) return false;
  return /does not exist|not found|could not find/i.test(message);
}

export function errorMessage(error: unknown): string {
  if (error instanceof CommandError && error.output) return `${error.message}\n${error.output}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

// Strips // and /* */ comments from JSONC text so it can be parsed with JSON.parse.
// Comment markers inside string literals are left untouched.
export function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (char === "\\" && next !== undefined) {
        result += next;
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

export async function runWrangler(command: string, args: string[], options: { input?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new CommandError(`${command} ${args.join(" ")} failed with exit code ${code}`, `${stdout}${stderr}`.trim()));
    });
  });
}

/**
 * Creates-or-verifies the D1 database, R2 bucket, and queues, patches the
 * D1 database id into wrangler.jsonc (replacing the <D1_DATABASE_ID>
 * placeholder without destroying comments), applies remote migrations, and
 * reports the Email Routing / send_email steps that cannot be automated.
 */
export async function ensureCloudflareResources(options: EnsureCloudflareResourcesOptions = {}): Promise<void> {
  const runCommand = options.runCommand ?? runWrangler;
  const configPath = options.configPath ?? "wrangler.jsonc";
  const readConfig = options.readConfig ?? ((path: string) => readFile(path, "utf8"));
  const writeConfig = options.writeConfig ?? writeFile;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const environment = options.environment ?? "production";
  const resources = options.resources ?? REQUIRED_RESOURCES[environment];

  if (options.dryRun) {
    printEnsurePlan({ environment, configPath, resources, configText: await readConfig(configPath), log });
    return;
  }

  await ensureD1Database({
    databaseName: resources.d1.databaseName,
    environment,
    configPath,
    readConfig,
    writeConfig,
    runCommand,
    log,
    error
  });

  for (const bucketName of resources.r2Buckets) {
    await ensureR2Bucket({ bucketName, configPath, runCommand, log, error });
  }

  for (const queueName of resources.queues) {
    try {
      await runCommand("wrangler", withConfig(["queues", "info", queueName], configPath));
      log(`Cloudflare Queue ${queueName} already exists.`);
      continue;
    } catch (infoError) {
      if (!isMissingResourceError(infoError)) {
        error(`Failed to inspect Cloudflare Queue ${queueName}: ${errorMessage(infoError)}`);
        throw infoError;
      }
    }

    try {
      log(`Creating Cloudflare Queue ${queueName}...`);
      await runCommand("wrangler", withConfig(["queues", "create", queueName], configPath));
      log(`Cloudflare Queue ${queueName} created.`);
    } catch (createError) {
      error(`Failed to create Cloudflare Queue ${queueName}: ${errorMessage(createError)}`);
      throw createError;
    }
  }

  reportManualEmailSteps(await readConfig(configPath), log);
}

function printEnsurePlan(options: {
  environment: CloudflareEnvironment;
  configPath: string;
  resources: RequiredCloudflareResources;
  configText: string;
  log: (message: string) => void;
}): void {
  const { log } = options;
  log(`Dry run: Cloudflare resource plan for ${options.environment} (no changes will be made):`);
  log(`- Create-or-verify D1 database ${options.resources.d1.databaseName} and patch its database_id into ${options.configPath}.`);
  log(`- Apply D1 migrations to ${options.resources.d1.databaseName} (--remote).`);
  for (const bucket of options.resources.r2Buckets) log(`- Create-or-verify R2 bucket ${bucket}.`);
  for (const queue of options.resources.queues) log(`- Create-or-verify queue ${queue}.`);
  reportManualEmailSteps(options.configText, log);
}

/**
 * Email Routing and Email Workers sender verification have no wrangler
 * commands; the operator has to do these once in the Cloudflare dashboard.
 */
function reportManualEmailSteps(configText: string, log: (message: string) => void): void {
  const config = JSON.parse(stripJsonComments(configText)) as {
    vars?: Record<string, string>;
    send_email?: Array<{ name?: string; allowed_sender_addresses?: string[] }>;
  };
  const recorder = config.vars?.DEFAULT_RECORDER_EMAIL ?? "<recorder email>";
  const senders = config.send_email?.flatMap((binding) => binding.allowed_sender_addresses ?? []) ?? [];
  if (!config.send_email || config.send_email.length === 0) {
    log("WARNING: wrangler.jsonc has no send_email binding; recap delivery will fail until one is configured.");
  }
  log("Manual steps (cannot be automated with wrangler):");
  log(`- Email Routing: enable it on the recorder domain and route ${recorder} to the minutesbot Worker (Email Workers rule).`);
  log(`- Email sending: the send_email sender address(es) ${senders.join(", ") || "<none configured>"} must belong to a zone on this account with Email Routing enabled.`);
  log("- Custom domains: the route patterns in wrangler.jsonc must be hostnames in a Cloudflare zone on this account.");
}

async function ensureD1Database(options: {
  databaseName: string;
  environment: CloudflareEnvironment;
  configPath: string;
  readConfig: (path: string) => Promise<string>;
  writeConfig: (path: string, contents: string) => Promise<void>;
  runCommand: RunCommand;
  log: (message: string) => void;
  error: (message: string) => void;
}): Promise<void> {
  let databaseId = await findD1DatabaseId(options.runCommand, options.databaseName, options.configPath);

  if (!databaseId) {
    options.log(`Creating Cloudflare D1 database ${options.databaseName}...`);
    await options.runCommand("wrangler", withConfig(["d1", "create", options.databaseName], options.configPath));
    databaseId = await findD1DatabaseId(options.runCommand, options.databaseName, options.configPath);
  }

  if (!databaseId) {
    throw new Error(`Cloudflare D1 database ${options.databaseName} was not found after creation.`);
  }

  const currentConfig = await options.readConfig(options.configPath);
  const updatedConfig = patchD1DatabaseId(currentConfig, options.databaseName, databaseId);
  if (updatedConfig !== currentConfig) {
    await options.writeConfig(options.configPath, updatedConfig);
    options.log(`Patched database_id for ${options.databaseName} into ${options.configPath}.`);
  }

  const migrationArgs = ["d1", "migrations", "apply", options.databaseName, "--remote"];
  if (options.environment === "staging") migrationArgs.push("--env", "staging");
  await options.runCommand("wrangler", withConfig(migrationArgs, options.configPath));
}

/**
 * Replaces the database_id paired with the given database_name via targeted
 * text substitution, so comments in wrangler.jsonc survive (a JSON.parse /
 * JSON.stringify round trip would drop them). Handles the <D1_DATABASE_ID>
 * placeholder and stale real ids alike.
 */
export function patchD1DatabaseId(configText: string, databaseName: string, databaseId: string): string {
  const name = escapeRegExp(databaseName);
  // database_name before database_id within the same object, or the reverse.
  const patterns = [
    `("database_name"\\s*:\\s*"${name}"[^{}]*?"database_id"\\s*:\\s*")[^"]*(")`,
    `("database_id"\\s*:\\s*")[^"]*("[^{}]*?"database_name"\\s*:\\s*"${name}")`
  ];
  for (const pattern of patterns) {
    if (new RegExp(pattern).test(configText)) {
      return configText.replace(new RegExp(pattern, "g"), `$1${databaseId}$2`);
    }
  }
  throw new Error(`Could not find a d1_databases entry for ${databaseName} in wrangler config to patch its database_id.`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ensureR2Bucket(options: {
  bucketName: string;
  configPath: string;
  runCommand: RunCommand;
  log: (message: string) => void;
  error: (message: string) => void;
}): Promise<void> {
  try {
    await options.runCommand("wrangler", withConfig(["r2", "bucket", "info", options.bucketName], options.configPath));
    options.log(`Cloudflare R2 bucket ${options.bucketName} already exists.`);
    return;
  } catch (infoError) {
    if (!isMissingResourceError(infoError)) {
      options.error(`Failed to inspect Cloudflare R2 bucket ${options.bucketName}: ${errorMessage(infoError)}`);
      throw infoError;
    }
  }

  try {
    options.log(`Creating Cloudflare R2 bucket ${options.bucketName}...`);
    await options.runCommand("wrangler", withConfig(["r2", "bucket", "create", options.bucketName], options.configPath));
    options.log(`Cloudflare R2 bucket ${options.bucketName} created.`);
  } catch (createError) {
    options.error(`Failed to create Cloudflare R2 bucket ${options.bucketName}: ${errorMessage(createError)}`);
    throw createError;
  }
}

async function findD1DatabaseId(runCommand: RunCommand, databaseName: string, configPath: string): Promise<string | undefined> {
  const output = await runCommand("wrangler", withConfig(["d1", "list", "--json"], configPath));
  if (typeof output !== "string" || output.length === 0) return undefined;
  const databases = parseD1ListOutput(output);
  const database = databases.find((item) => item.name === databaseName);
  return database?.uuid ?? database?.id ?? database?.database_id;
}

function withConfig(args: string[], configPath: string): string[] {
  return configPath === "wrangler.jsonc" ? args : [...args, "--config", configPath];
}

function parseD1ListOutput(output: string): Array<{ name?: string; uuid?: string; id?: string; database_id?: string }> {
  const parsed: unknown = JSON.parse(output);
  if (Array.isArray(parsed)) return parsed as Array<{ name?: string; uuid?: string; id?: string; database_id?: string }>;
  if (isObject(parsed) && Array.isArray(parsed.result)) {
    return parsed.result as Array<{ name?: string; uuid?: string; id?: string; database_id?: string }>;
  }
  return [];
}

function isObject(value: unknown): value is { result?: unknown } {
  return typeof value === "object" && value !== null;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  ensureCloudflareResources({
    environment: parseEnvironment(process.argv),
    dryRun: process.argv.includes("--dry-run")
  }).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}

function parseEnvironment(args: string[]): CloudflareEnvironment {
  const envFlagIndex = args.indexOf("--env");
  const value = envFlagIndex >= 0 ? args[envFlagIndex + 1] : undefined;
  if (value === "staging" || value === "production" || value === "development") return value;
  return "production";
}
