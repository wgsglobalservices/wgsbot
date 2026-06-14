import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkHealth } from "./check-health";
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
  runBuildCommand?: RunCommand;
  runHealthCheck?: (env: Record<string, string | undefined>) => Promise<number>;
  readConfig?: (path: string) => Promise<string>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Production deploy path for the main Worker:
 * 1. create-or-verify Cloudflare resources, patch the D1 database id, and
 *    apply remote migrations (ensure-cloudflare-resources)
 * 2. refuse to deploy while wrangler.jsonc still contains placeholders
 * 3. build web assets and workspace packages
 * 4. wrangler deploy
 * 5. post-deploy smoke checks via check-health
 */
export async function deployMinutesbot(options: DeployMinutesbotOptions = {}): Promise<void> {
  const environment = options.environment ?? "production";
  const ensureResources = options.ensureResources ?? ensureCloudflareResources;
  const runCommand = options.runCommand ?? runWrangler;
  const runBuildCommand = options.runBuildCommand ?? runInheritedCommand;
  const readConfig = options.readConfig ?? ((path: string) => readFile(path, "utf8"));
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  if (environment !== "production") {
    await assertEnvironmentBlockExists(environment, readConfig);
  }

  // Provisioning runs first because it is what replaces the <D1_DATABASE_ID>
  // placeholder; domain/email placeholders must already be patched by
  // `pnpm setup:cloudflare` or by hand.
  await ensureResources({ environment, runCommand, log, error });

  const configText = await readConfig("wrangler.jsonc");
  assertNoPlaceholders(configText);

  await runBuildCommand("pnpm", ["run", "build"]);
  await runCommand("wrangler", environment === "production" ? ["deploy"] : ["deploy", "--env", environment]);

  const runHealthCheck = options.runHealthCheck ?? ((env) => checkHealth({ env, log, error }));
  const exitCode = await runHealthCheck(smokeCheckEnv(configText));
  if (exitCode !== 0) {
    throw new Error("Post-deploy health checks failed. The Worker is deployed but unhealthy; see the failures above.");
  }
  log("Deploy complete and healthy.");
}

/**
 * The checked-in config intentionally ships with <PLACEHOLDER> ids and
 * example.com domains. Deploying those would create a Worker that can never
 * receive traffic, so fail with instructions instead.
 */
export function assertNoPlaceholders(configText: string): void {
  const stripped = stripJsonComments(configText);
  const placeholders = new Set<string>();
  for (const match of stripped.matchAll(/<[A-Z0-9_]+>/g)) placeholders.add(match[0]);
  for (const match of stripped.matchAll(/[a-z0-9.-]*example\.com/g)) placeholders.add(match[0]);
  if (placeholders.size > 0) {
    throw new Error(
      `wrangler.jsonc still contains placeholder values: ${[...placeholders].join(", ")}. Run \`pnpm setup:cloudflare\` (or edit wrangler.jsonc) to set your domains, recorder email, and database id before deploying.`
    );
  }
}

function smokeCheckEnv(configText: string): Record<string, string | undefined> {
  const config = JSON.parse(stripJsonComments(configText)) as { vars?: Record<string, string> };
  return {
    API_BASE_URL: config.vars?.API_BASE_URL,
    BOT_API_BASE_URL: config.vars?.BOT_API_BASE_URL,
    MINUTESBOT_ADMIN_TOKEN: process.env.MINUTESBOT_ADMIN_TOKEN
  };
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
  deployMinutesbot({ environment: parseDeployEnvironment(process.argv) }).catch((error: unknown) => {
    // errorMessage includes the captured wrangler output from CommandError failures.
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
