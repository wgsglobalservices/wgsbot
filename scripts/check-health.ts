import { resolveNs as nodeResolveNs } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stripJsonComments } from "./ensure-cloudflare-resources";

const CLOUDFLARE_NAMESERVER_SUFFIX = ".ns.cloudflare.com";

export type HealthCheckResult = {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
};

type CheckHealthOptions = {
  env?: Record<string, string | undefined>;
  fetchHealth?: typeof fetch;
  resolveNs?: (hostname: string) => Promise<string[]>;
  readConfig?: (path: string) => Promise<string>;
  log?: (message: string) => void;
  error?: (message: string) => void;
};

/**
 * Post-deploy smoke checks: API worker health/readiness, bot runtime
 * health/readiness, and (when an admin token is available) an R2 round trip
 * through the authed admin test endpoint. Returns a process exit code.
 */
export async function checkHealth(options: CheckHealthOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const fetchHealth = options.fetchHealth ?? fetch;
  const resolveNs = options.resolveNs ?? nodeResolveNs;
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;

  const configVars = await readConfigVars(options);
  const apiBaseUrl = trimUrl(env.API_BASE_URL) ?? trimUrl(configVars?.API_BASE_URL) ?? "http://localhost:8787";
  const botBaseUrl = trimUrl(env.BOT_API_BASE_URL) ?? trimUrl(configVars?.BOT_API_BASE_URL);
  const adminToken = env.MINUTESBOT_ADMIN_TOKEN;

  const results: HealthCheckResult[] = [];
  results.push(await checkEndpoint(fetchHealth, "GET", `${apiBaseUrl}/api/health`));
  results.push(await checkEndpoint(fetchHealth, "GET", `${apiBaseUrl}/api/ready`));

  if (botBaseUrl) {
    results.push(await checkEndpoint(fetchHealth, "GET", `${botBaseUrl}/_ops/health`));
    results.push(await checkEndpoint(fetchHealth, "GET", `${botBaseUrl}/_ops/ready`));
  } else {
    results.push({ name: "GET <bot runtime>/_ops/health", status: "skip", detail: "BOT_API_BASE_URL not configured" });
    results.push({ name: "GET <bot runtime>/_ops/ready", status: "skip", detail: "BOT_API_BASE_URL not configured" });
  }

  if (adminToken) {
    results.push(
      await checkEndpoint(fetchHealth, "POST", `${apiBaseUrl}/api/admin/test-r2`, {
        authorization: `Bearer ${adminToken}`
      })
    );
  } else {
    results.push({
      name: `POST ${apiBaseUrl}/api/admin/test-r2`,
      status: "skip",
      detail: "set MINUTESBOT_ADMIN_TOKEN to run the R2 round-trip check (admin-token auth mode only)"
    });
  }

  for (const result of results) {
    log(`${result.status.toUpperCase().padEnd(4)}  ${result.name}  ${result.detail}`.trimEnd());
  }

  const failed = results.filter((result) => result.status === "fail");
  if (failed.length === 0) {
    log("All health checks passed.");
    return 0;
  }

  const apiHealth = results[0];
  if (apiHealth.status === "fail") {
    await explainDeploymentNotFound({ url: `${apiBaseUrl}/api/health`, detail: apiHealth.detail, resolveNs, error });
  }
  error(`${failed.length} health check(s) failed.`);
  return 1;
}

async function checkEndpoint(
  fetchHealth: typeof fetch,
  method: "GET" | "POST",
  url: string,
  headers: Record<string, string> = {}
): Promise<HealthCheckResult> {
  const name = `${method} ${url}`;
  try {
    const response = await fetchHealth(url, { method, headers });
    const body = (await response.text()).slice(0, 200);
    const detail = `${response.status} ${body}`.trim();
    if (response.ok) return { name, status: "pass", detail };
    return { name, status: "fail", detail: withResponseHints(detail, response) };
  } catch (cause) {
    return { name, status: "fail", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

function withResponseHints(detail: string, response: Response): string {
  const vercelError = response.headers.get("x-vercel-error");
  const server = response.headers.get("server");
  if (vercelError === "DEPLOYMENT_NOT_FOUND" || server?.toLowerCase().includes("vercel")) {
    return `${detail} [served by Vercel, not Cloudflare]`;
  }
  return detail;
}

function trimUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, "");
}

async function readConfigVars(options: CheckHealthOptions): Promise<Record<string, string> | undefined> {
  const readConfig = options.readConfig ?? ((path: string) => readFile(path, "utf8"));
  try {
    const config = JSON.parse(stripJsonComments(await readConfig("wrangler.jsonc"))) as { vars?: Record<string, string> };
    const vars = config.vars ?? {};
    // Placeholder domains are not reachable; treat them as unset.
    return Object.fromEntries(Object.entries(vars).filter(([, value]) => !value.includes("example.com")));
  } catch {
    return undefined;
  }
}

/**
 * A common first-deploy failure: the zone still resolves through another
 * host's nameservers (for example Vercel), so Cloudflare custom domains can
 * never receive traffic. Detect it and explain the fix.
 */
async function explainDeploymentNotFound(options: {
  url: string;
  detail: string;
  resolveNs: (hostname: string) => Promise<string[]>;
  error: (message: string) => void;
}): Promise<void> {
  if (!options.detail.includes("[served by Vercel, not Cloudflare]")) return;

  const hostname = new URL(options.url).hostname;
  const domain = rootDomain(hostname);
  const nameservers = await options.resolveNs(domain);
  const normalizedNameservers = nameservers.map((value) => value.toLowerCase().replace(/\.$/, ""));

  const usesCloudflareNameservers =
    normalizedNameservers.length > 0 && normalizedNameservers.every((nameserver) => nameserver.endsWith(CLOUDFLARE_NAMESERVER_SUFFIX));
  if (!usesCloudflareNameservers) {
    options.error(`${domain} is resolving through Vercel nameservers, so Cloudflare Workers cannot serve the app.`);
    options.error(`Current nameservers: ${normalizedNameservers.join(", ") || "none"}`);
    options.error(
      "Change the registrar nameservers to the Cloudflare nameservers assigned to your zone — see the Cloudflare dashboard, then rerun pnpm check."
    );
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
