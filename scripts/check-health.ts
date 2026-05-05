import { resolveNs as nodeResolveNs } from "node:dns/promises";
import { fileURLToPath } from "node:url";

const CLOUDFLARE_NAMESERVERS = ["abby.ns.cloudflare.com", "arvind.ns.cloudflare.com"];

type CheckHealthOptions = {
  env?: Record<string, string | undefined>;
  fetchHealth?: typeof fetch;
  resolveNs?: (hostname: string) => Promise<string[]>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export async function checkHealth(options: CheckHealthOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const fetchHealth = options.fetchHealth ?? fetch;
  const resolveNs = options.resolveNs ?? nodeResolveNs;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const url = healthUrl(env);

  try {
    const response = await fetchHealth(url);
    const body = await response.text();
    log(`${response.status} ${body}`);

    if (response.ok) return 0;

    await explainDeploymentNotFound({ url, response, resolveNs, error });
    return 1;
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

function healthUrl(env: Record<string, string | undefined>): string {
  return env.API_BASE_URL ? `${env.API_BASE_URL.replace(/\/+$/, "")}/api/health` : "http://localhost:8787/api/health";
}

async function explainDeploymentNotFound(options: {
  url: string;
  response: Response;
  resolveNs: (hostname: string) => Promise<string[]>;
  error: (message: string) => void;
}): Promise<void> {
  const vercelError = options.response.headers.get("x-vercel-error");
  const server = options.response.headers.get("server");
  if (vercelError !== "DEPLOYMENT_NOT_FOUND" && !server?.toLowerCase().includes("vercel")) return;

  const hostname = new URL(options.url).hostname;
  const domain = rootDomain(hostname);
  const nameservers = await options.resolveNs(domain);
  const normalizedNameservers = nameservers.map((value) => value.toLowerCase().replace(/\.$/, ""));

  if (!CLOUDFLARE_NAMESERVERS.every((nameserver) => normalizedNameservers.includes(nameserver))) {
    options.error(`${domain} is resolving through Vercel nameservers, so Cloudflare Workers cannot serve the app.`);
    options.error(`Current nameservers: ${normalizedNameservers.join(", ") || "none"}`);
    options.error(`Change the registrar nameservers to ${CLOUDFLARE_NAMESERVERS.join(" and ")}, then rerun pnpm check.`);
  }
}

function rootDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  checkHealth().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
