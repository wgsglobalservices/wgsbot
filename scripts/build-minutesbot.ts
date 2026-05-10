import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ensureCloudflareResources,
  type CloudflareEnvironment,
  type EnsureCloudflareResourcesOptions,
  type RunCommand
} from "./ensure-cloudflare-resources";

type EnsureResources = (options: EnsureCloudflareResourcesOptions) => Promise<void>;

type BuildMinutesbotOptions = {
  env?: Record<string, string | undefined>;
  ensureResources?: EnsureResources;
  runBuildCommand?: RunCommand;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export async function buildMinutesbot(options: BuildMinutesbotOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const ensureResources = options.ensureResources ?? ensureCloudflareResources;
  const runBuildCommand = options.runBuildCommand ?? runInheritedCommand;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const environment = parseBuildEnvironment(env);

  if (env.WORKERS_CI === "1") {
    log(`Workers Builds detected. Ensuring Cloudflare resources for ${environment}...`);
    await ensureResources({ environment, log, error });
  }

  await runBuildCommand("pnpm", ["run", "build:workspace"]);
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
