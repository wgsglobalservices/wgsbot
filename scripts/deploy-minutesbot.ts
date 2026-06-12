import { fileURLToPath } from "node:url";
import {
  ensureCloudflareResources,
  runWrangler,
  type CloudflareEnvironment,
  type EnsureCloudflareResourcesOptions,
  type RunCommand
} from "./ensure-cloudflare-resources";

type EnsureResources = (options: EnsureCloudflareResourcesOptions) => Promise<void>;

type DeployMinutesbotOptions = {
  environment?: CloudflareEnvironment;
  ensureResources?: EnsureResources;
  runCommand?: RunCommand;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export async function deployMinutesbot(options: DeployMinutesbotOptions = {}): Promise<void> {
  const environment = options.environment ?? "production";
  const ensureResources = options.ensureResources ?? ensureCloudflareResources;
  const runCommand = options.runCommand ?? runWrangler;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  await ensureResources({ environment, runCommand, log, error });
  await runCommand("wrangler", environment === "production" ? ["deploy"] : ["deploy", "--env", environment]);
}

export function parseDeployEnvironment(args: string[]): CloudflareEnvironment {
  const envFlagIndex = args.indexOf("--env");
  const value = envFlagIndex >= 0 ? args[envFlagIndex + 1] : "production";
  if (value === "production" || value === "staging") return value;
  throw new Error(`Unsupported deploy environment "${value}". Use "production" or "staging".`);
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  deployMinutesbot({ environment: parseDeployEnvironment(process.argv) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
