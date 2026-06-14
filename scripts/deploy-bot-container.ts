import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoPlaceholders } from "./deploy-minutesbot";
import { errorMessage, runWrangler, stripJsonComments, type RunCommand } from "./ensure-cloudflare-resources";

const SOURCE_CONFIG = "deploy/bot-container/wrangler.jsonc";
const GENERATED_CONFIG = ".wrangler/bot-container.jsonc";
const INTERNAL_TOKEN_SECRET = "BOT_INTERNAL_TOKEN";

type BotContainerConfig = {
  $schema?: string;
  main?: string;
  vars?: Record<string, string>;
  containers?: Array<{ image?: string } & Record<string, unknown>>;
} & Record<string, unknown>;

type DeployBotContainerOptions = {
  environment?: "production" | "staging";
  rotateToken?: boolean;
  runCommand?: RunCommand;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
  makeDir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  generateToken?: () => string;
  log?: (message: string) => void;
};

/**
 * Deploys the meeting bot Cloudflare Container worker:
 * 1. generates .wrangler/bot-container.jsonc from deploy/bot-container/wrangler.jsonc
 *    with a fresh BOT_CONTAINER_INSTANCE_ID (so Containers stop routing to an
 *    old sleeping instance) and the current git sha as BOT_RUNTIME_VERSION
 * 2. wrangler deploy --config (builds Dockerfile.bot and pushes the image;
 *    requires a running Docker daemon)
 * 3. provisions BOT_INTERNAL_TOKEN: if the secret is missing on either the
 *    bot worker or the main minutesbot worker (or --rotate-token is passed),
 *    a fresh random token is generated and pushed to BOTH workers. The token
 *    is never stored in source, .env files, or D1, and never printed.
 */
export async function deployBotContainer(options: DeployBotContainerOptions = {}): Promise<void> {
  const environment = options.environment ?? "production";
  const runCommand = options.runCommand ?? runWrangler;
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const log = options.log ?? console.log;

  const sourceText = await readTextFile(SOURCE_CONFIG);
  assertNoPlaceholders(sourceText);

  await assertWranglerAuthenticated(runCommand);
  await assertDockerAvailable(runCommand);

  const config = JSON.parse(stripJsonComments(sourceText)) as BotContainerConfig;
  const generated = buildGeneratedConfig(config, {
    instanceId: generateBotContainerInstanceId(environment),
    runtimeVersion: await currentGitShortSha(runCommand)
  });
  await writeGeneratedConfig(GENERATED_CONFIG, generated, options);
  log(`Generated ${GENERATED_CONFIG} with fresh BOT_CONTAINER_INSTANCE_ID=${generated.vars?.BOT_CONTAINER_INSTANCE_ID}`);

  await runCommand("wrangler", ["deploy", "--config", GENERATED_CONFIG]);

  await ensureInternalToken({ runCommand, rotateToken: options.rotateToken ?? false, generateToken: options.generateToken, log });
}

/** Rewrites source-relative paths for the generated config under .wrangler/. */
export function buildGeneratedConfig(
  config: BotContainerConfig,
  versions: { instanceId: string; runtimeVersion: string }
): BotContainerConfig {
  return {
    ...config,
    $schema: "../node_modules/wrangler/config-schema.json",
    main: "../deploy/bot-container/src/index.ts",
    containers: (config.containers ?? []).map((container) => ({ ...container, image: "../Dockerfile.bot" })),
    vars: {
      ...config.vars,
      BOT_CONTAINER_INSTANCE_ID: versions.instanceId,
      BOT_RUNTIME_VERSION: versions.runtimeVersion
    }
  };
}

/**
 * Internal bot auth is provisioned here, not configured by hand: the main
 * worker presents the token to /v1/* on the bot runtime, and the runtime
 * presents it back on webhooks and recording uploads, so the value must be
 * identical on both workers.
 */
async function ensureInternalToken(options: {
  runCommand: RunCommand;
  rotateToken: boolean;
  generateToken?: () => string;
  log: (message: string) => void;
}): Promise<void> {
  const { runCommand, log } = options;
  const onBotWorker = await secretExists(runCommand, GENERATED_CONFIG);
  const onMainWorker = await secretExists(runCommand, undefined);

  if (onBotWorker && onMainWorker && !options.rotateToken) {
    log(`${INTERNAL_TOKEN_SECRET} already set on both workers; pass --rotate-token to rotate it.`);
    return;
  }

  const generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  const token = generateToken();
  log(`Provisioning a fresh ${INTERNAL_TOKEN_SECRET} on the bot worker and the main minutesbot worker...`);
  await runCommand("wrangler", ["secret", "put", INTERNAL_TOKEN_SECRET, "--config", GENERATED_CONFIG], { input: token });
  try {
    await runCommand("wrangler", ["secret", "put", INTERNAL_TOKEN_SECRET], { input: token });
  } catch (cause) {
    throw new Error(
      `Failed to set ${INTERNAL_TOKEN_SECRET} on the main minutesbot worker. Deploy it first (pnpm deploy), then rerun pnpm bot:deploy so both workers share the same token.\n${errorMessage(cause)}`
    );
  }
  log(`${INTERNAL_TOKEN_SECRET} set on both workers.`);
}

async function secretExists(runCommand: RunCommand, configPath: string | undefined): Promise<boolean> {
  try {
    const args = configPath ? ["secret", "list", "--config", configPath] : ["secret", "list"];
    const output = await runCommand("wrangler", args);
    return typeof output === "string" && output.includes(INTERNAL_TOKEN_SECRET);
  } catch {
    // A missing worker (first deploy) lists no secrets.
    return false;
  }
}

async function assertDockerAvailable(runCommand: RunCommand): Promise<void> {
  try {
    await runCommand("docker", ["info"]);
  } catch (cause) {
    throw new Error(
      `Docker is required to build the bot container image (Dockerfile.bot) but does not appear to be running.\n${errorMessage(cause)}`
    );
  }
}

async function assertWranglerAuthenticated(runCommand: RunCommand): Promise<void> {
  try {
    await runCommand("wrangler", ["whoami"]);
  } catch (cause) {
    throw new Error(
      `Wrangler must be logged in before deploying the bot container. Run \`wrangler login\` or set a scoped CLOUDFLARE_API_TOKEN with Workers, Containers, and secrets access, then rerun \`pnpm bot:deploy\`.\n${errorMessage(cause)}`
    );
  }
}

async function writeGeneratedConfig(path: string, config: BotContainerConfig, options: DeployBotContainerOptions): Promise<void> {
  const makeDir = options.makeDir ?? mkdir;
  const writeTextFile = options.writeTextFile ?? ((target: string, value: string) => writeFile(target, value));
  await makeDir(dirname(path), { recursive: true });
  await writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

function generateBotContainerInstanceId(environment: "production" | "staging"): string {
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return `${environment}-${timestamp}-${randomBytes(4).toString("hex")}`;
}

async function currentGitShortSha(runCommand: RunCommand): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--short=12", "HEAD"]);
  const sha = String(result ?? "").trim();
  if (!sha) throw new Error("Unable to determine BOT_RUNTIME_VERSION from git.");
  return sha;
}

function parseArgs(args: string[]): { environment: "production" | "staging"; rotateToken: boolean } {
  const envFlagIndex = args.indexOf("--env");
  const environment = envFlagIndex >= 0 ? args[envFlagIndex + 1] : "production";
  if (environment !== "production" && environment !== "staging") {
    throw new Error(`Unsupported bot deploy environment "${environment}". Use "production" or "staging".`);
  }
  return { environment, rotateToken: args.includes("--rotate-token") };
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1] === join(process.cwd(), "scripts/deploy-bot-container.ts");

if (isCli) {
  deployBotContainer(parseArgs(process.argv)).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
