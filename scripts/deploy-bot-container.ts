import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBotWranglerConfig, parseEnvFile, validateOneshotEnv } from "./deploy-oneshot";

type RunCommand = (command: string, args: string[]) => Promise<string | void>;

type DeployBotContainerOptions = {
  environment?: "production" | "staging";
  envFilePath?: string;
  env?: Record<string, string | undefined>;
  runCommand?: RunCommand;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, contents: string) => Promise<void>;
  makeDir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  log?: (message: string) => void;
};

const GENERATED_BOT_CONFIG = ".wrangler/oneshot-bot.jsonc";

export async function deployBotContainer(options: DeployBotContainerOptions = {}): Promise<void> {
  const environment = options.environment ?? "production";
  const runCommand = options.runCommand ?? runProcess;
  const log = options.log ?? console.log;
  const loadedEnv = await loadBotDeployEnv(options);
  const env = {
    ...loadedEnv,
    CLOUDFLARE_ENV: loadedEnv.CLOUDFLARE_ENV?.trim() || environment,
    BOT_CONTAINER_INSTANCE_ID: generateBotContainerInstanceId(environment),
    BOT_RUNTIME_VERSION: await currentGitShortSha(runCommand)
  };

  validateOneshotEnv(env, environment);
  const config = buildBotWranglerConfig(env, environment);
  await writeGeneratedConfig(GENERATED_BOT_CONFIG, config, options);
  log(`Generated ${GENERATED_BOT_CONFIG} with fresh BOT_CONTAINER_INSTANCE_ID=${env.BOT_CONTAINER_INSTANCE_ID}`);
  await runCommand("wrangler", ["deploy", "--config", GENERATED_BOT_CONFIG]);
}

function parseArgs(args: string[]): { environment: "production" | "staging"; envFilePath?: string } {
  const envFlagIndex = args.indexOf("--env");
  const environment = envFlagIndex >= 0 ? args[envFlagIndex + 1] : "production";
  if (environment !== "production" && environment !== "staging") {
    throw new Error(`Unsupported bot deploy environment "${environment}". Use "production" or "staging".`);
  }
  const envFileIndex = args.indexOf("--env-file");
  return {
    environment,
    envFilePath: envFileIndex >= 0 ? args[envFileIndex + 1] : undefined
  };
}

async function loadBotDeployEnv(options: DeployBotContainerOptions): Promise<Record<string, string | undefined>> {
  if (options.env) return options.env;
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const envFilePath = options.envFilePath ?? ".env.oneshot";
  const fileEnv = parseEnvFile(await readTextFile(envFilePath));
  return { ...fileEnv, ...process.env };
}

async function writeGeneratedConfig(path: string, contents: string, options: DeployBotContainerOptions): Promise<void> {
  const makeDir = options.makeDir ?? mkdir;
  const writeTextFile = options.writeTextFile ?? ((target: string, value: string) => writeFile(target, value));
  await makeDir(dirname(path), { recursive: true });
  await writeTextFile(path, contents);
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

async function runProcess(command: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stdout}${stderr}`.trim()));
    });
  });
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1] === join(process.cwd(), "scripts/deploy-bot-container.ts");

if (isCli) {
  const parsed = parseArgs(process.argv);
  deployBotContainer(parsed).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
