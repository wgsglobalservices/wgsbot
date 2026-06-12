import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REQUIRED_RESOURCES = {
  development: {
    d1: { binding: "DB", databaseName: "minutesbot" },
    r2Buckets: ["minutesbot-artifacts"],
    queues: ["minutesbot-invites", "minutesbot-summaries", "minutesbot-email"]
  },
  production: {
    d1: { binding: "DB", databaseName: "minutesbot" },
    r2Buckets: ["minutesbot-artifacts"],
    queues: ["minutesbot-invites", "minutesbot-summaries", "minutesbot-email"]
  },
  staging: {
    d1: { binding: "DB", databaseName: "minutesbot-staging" },
    r2Buckets: ["minutesbot-staging-artifacts"],
    queues: ["minutesbot-staging-invites", "minutesbot-staging-summaries", "minutesbot-staging-email"]
  }
} as const;

export type CloudflareEnvironment = keyof typeof REQUIRED_RESOURCES;

export type RunCommand = (command: string, args: string[]) => Promise<string | void>;

export type RequiredCloudflareResources = {
  d1: { binding: string; databaseName: string };
  r2Buckets: string[];
  queues: string[];
};

export type EnsureCloudflareResourcesOptions = {
  environment?: CloudflareEnvironment;
  configPath?: string;
  runCommand?: RunCommand;
  readConfig?: (path: string) => Promise<string>;
  writeConfig?: (path: string, contents: string) => Promise<void>;
  resources?: RequiredCloudflareResources;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type D1Binding = {
  binding: string;
  database_name: string;
  database_id: string;
};

type WranglerConfig = {
  d1_databases?: D1Binding[];
  env?: Record<string, { d1_databases?: D1Binding[] }>;
};

class CommandError extends Error {
  constructor(
    message: string,
    readonly output: string
  ) {
    super(message);
  }
}

function isMissingQueueError(error: unknown): boolean {
  const message = error instanceof CommandError ? `${error.message}\n${error.output}` : error instanceof Error ? error.message : String(error);
  return /does not exist|not found|could not find/i.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof CommandError && error.output) return `${error.message}\n${error.output}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runWrangler(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      reject(new CommandError(`${command} ${args.join(" ")} failed with exit code ${code}`, `${stdout}${stderr}`.trim()));
    });
  });
}

export async function ensureCloudflareResources(options: EnsureCloudflareResourcesOptions = {}): Promise<void> {
  const runCommand = options.runCommand ?? runWrangler;
  const configPath = options.configPath ?? "wrangler.jsonc";
  const readConfig = options.readConfig ?? ((path: string) => readFile(path, "utf8"));
  const writeConfig = options.writeConfig ?? writeFile;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const environment = options.environment ?? "production";
  const resources = options.resources ?? REQUIRED_RESOURCES[environment];

  await ensureD1Database({
    binding: resources.d1.binding,
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
      if (!isMissingQueueError(infoError)) {
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
}

async function ensureD1Database(options: {
  binding: string;
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
  const updatedConfig = updateD1DatabaseIdInConfig({
    configText: currentConfig,
    environment: options.environment,
    binding: options.binding,
    databaseName: options.databaseName,
    databaseId
  });
  if (updatedConfig !== currentConfig) await options.writeConfig(options.configPath, updatedConfig);

  const migrationArgs = ["d1", "migrations", "apply", options.databaseName, "--remote"];
  if (options.environment === "staging") migrationArgs.push("--env", "staging");
  await options.runCommand("wrangler", withConfig(migrationArgs, options.configPath));
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
    if (!isMissingQueueError(infoError)) {
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

function updateD1DatabaseIdInConfig(options: {
  configText: string;
  environment: CloudflareEnvironment;
  binding: string;
  databaseName: string;
  databaseId: string;
}): string {
  const config = JSON.parse(options.configText) as WranglerConfig;
  if (options.environment === "production" || options.environment === "development") {
    config.d1_databases = updateD1Bindings(config.d1_databases, options.binding, options.databaseName, options.databaseId);
  }
  if (config.env?.[options.environment]) {
    config.env[options.environment].d1_databases = updateD1Bindings(
      config.env[options.environment].d1_databases,
      options.binding,
      options.databaseName,
      options.databaseId
    );
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function updateD1Bindings(
  bindings: D1Binding[] | undefined,
  bindingName: string,
  databaseName: string,
  databaseId: string
): D1Binding[] {
  const nextBindings = bindings ? [...bindings] : [];
  const bindingIndex = nextBindings.findIndex((binding) => binding.binding === bindingName || binding.database_name === databaseName);
  const nextBinding = { binding: bindingName, database_name: databaseName, database_id: databaseId };
  if (bindingIndex >= 0) {
    nextBindings[bindingIndex] = { ...nextBindings[bindingIndex], ...nextBinding };
  } else {
    nextBindings.push(nextBinding);
  }
  return nextBindings;
}

function isObject(value: unknown): value is { result?: unknown } {
  return typeof value === "object" && value !== null;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  ensureCloudflareResources({ environment: parseEnvironment(process.argv) }).catch(() => {
    process.exitCode = 1;
  });
}

function parseEnvironment(args: string[]): CloudflareEnvironment {
  const envFlagIndex = args.indexOf("--env");
  const value = envFlagIndex >= 0 ? args[envFlagIndex + 1] : undefined;
  if (value === "staging" || value === "production" || value === "development") return value;
  return "production";
}
