import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REQUIRED_QUEUES = ["minutesbot-invites", "minutesbot-summaries", "minutesbot-email"] as const;

export type RunCommand = (command: string, args: string[]) => Promise<void>;

export type EnsureCloudflareResourcesOptions = {
  runCommand?: RunCommand;
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

function isMissingQueueError(error: unknown): boolean {
  const message = error instanceof CommandError ? `${error.message}\n${error.output}` : error instanceof Error ? error.message : String(error);
  return /does not exist|not found|could not find/i.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof CommandError && error.output) return `${error.message}\n${error.output}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runWrangler(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new CommandError(`${command} ${args.join(" ")} failed with exit code ${code}`, output.trim()));
    });
  });
}

export async function ensureCloudflareResources(options: EnsureCloudflareResourcesOptions = {}): Promise<void> {
  const runCommand = options.runCommand ?? runWrangler;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  for (const queueName of REQUIRED_QUEUES) {
    try {
      await runCommand("wrangler", ["queues", "info", queueName]);
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
      await runCommand("wrangler", ["queues", "create", queueName]);
      log(`Cloudflare Queue ${queueName} created.`);
    } catch (createError) {
      error(`Failed to create Cloudflare Queue ${queueName}: ${errorMessage(createError)}`);
      throw createError;
    }
  }
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  ensureCloudflareResources().catch(() => {
    process.exitCode = 1;
  });
}
