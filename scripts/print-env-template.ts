import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Prints the .env template. The checked-in .env.example is the single source
 * of truth; this command exists so `pnpm env:template > .env` works without
 * hunting for the file.
 */
export async function printEnvTemplate(options: {
  readTextFile?: (path: string) => Promise<string>;
  log?: (message: string) => void;
} = {}): Promise<void> {
  const readTextFile = options.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const log = options.log ?? console.log;
  log((await readTextFile(".env.example")).trimEnd());
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  printEnvTemplate().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
