import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ensureCloudflareResources,
  errorMessage,
  runWrangler,
  stripJsonComments,
  type CloudflareEnvironment,
  type EnsureCloudflareResourcesOptions,
  type RunCommand
} from "./ensure-cloudflare-resources";

type EnsureResources = (options: EnsureCloudflareResourcesOptions) => Promise<void>;

type DeployMinutesbotOptions = {
  environment?: CloudflareEnvironment;
  ensureResources?: EnsureResources;
  runCommand?: RunCommand;
  readConfig?: (path: string) => Promise<string>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export async function deployMinutesbot(options: DeployMinutesbotOptions = {}): Promise<void> {
  const environment = options.environment ?? "production";
  const ensureResources = options.ensureResources ?? ensureCloudflareResources;
  const runCommand = options.runCommand ?? runWrangler;
  const readConfig = options.readConfig ?? ((path: string) => readFile(path, "utf8"));
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  if (environment !== "production") {
    await assertEnvironmentBlockExists(environment, readConfig);
  }

  await ensureResources({ environment, runCommand, log, error });
  await runCommand("wrangler", environment === "production" ? ["deploy"] : ["deploy", "--env", environment]);
}

// Without an env.<name> block, wrangler 4 falls back to legacy environment mode and deploys a
// minutesbot-<name> Worker that inherits the PRODUCTION D1 database id, bucket, queue
// consumers, and custom domains. Fail closed instead of deploying that.
async function assertEnvironmentBlockExists(
  environment: CloudflareEnvironment,
  readConfig: (path: string) => Promise<string>
): Promise<void> {
  const config = JSON.parse(stripJsonComments(await readConfig("wrangler.jsonc"))) as { env?: Record<string, unknown> };
  if (!config.env?.[environment]) {
    throw new Error(
      `wrangler.jsonc has no "env.${environment}" block. Deploying with --env ${environment} would fall back to wrangler's legacy environment mode and reuse the production D1 database, bucket, queue consumers, and custom domains. Add an env.${environment} block to wrangler.jsonc before deploying.`
    );
  }
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
    // errorMessage includes the captured wrangler output from CommandError failures.
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
