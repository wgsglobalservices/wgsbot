import { fileURLToPath } from "node:url";

const DEFAULT_ACCOUNT_ID = "";
const DEFAULT_ZONE_NAME = "minutes.bot";
const DEFAULT_WEBHOOK_HOST = "meeting.minutes.bot";
const DEFAULT_WEBHOOK_PATH = "/api/webhooks/bot";
const FIREWALL_CUSTOM_PHASE = "http_request_firewall_custom";
const WEBHOOK_HOST_PATTERN = /^[a-z0-9.-]+$/i;
const WEBHOOK_PATH_PATTERN = /^[A-Za-z0-9/_.-]*$/;

export const BOT_WEBHOOK_SECURITY_EXCEPTION_REF = "minutesbot_bot_webhook_security_exception";
export const BOT_WEBHOOK_SECURITY_EXCEPTION_EXPRESSION =
  'http.host eq "meeting.minutes.bot" and http.request.uri.path eq "/api/webhooks/bot" and http.request.method eq "POST"';

type CloudflareFetch = typeof fetch;

type CloudflareResponse<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};

type Zone = {
  id: string;
  name: string;
};

type RulesetRule = {
  id?: string;
  ref?: string;
  description?: string;
  expression: string;
  action: string;
  action_parameters?: Record<string, unknown>;
  enabled?: boolean;
};

type Ruleset = {
  id?: string;
  name?: string;
  description?: string;
  kind?: string;
  phase?: string;
  rules?: RulesetRule[];
};

type EnsureWebhookSecurityExceptionOptions = {
  apiToken?: string;
  accountId?: string;
  zoneName?: string;
  zoneId?: string;
  webhookHost?: string;
  webhookPath?: string;
  fetcher?: CloudflareFetch;
  log?: (message: string) => void;
};

export async function ensureWebhookSecurityException(options: EnsureWebhookSecurityExceptionOptions = {}): Promise<void> {
  const apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required to update Cloudflare WAF rulesets.");

  const fetcher = options.fetcher ?? fetch;
  const log = options.log ?? console.log;
  const zoneId =
    options.zoneId ??
    process.env.CLOUDFLARE_ZONE_ID ??
    (await findZoneId({
      apiToken,
      accountId: options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? DEFAULT_ACCOUNT_ID,
      zoneName: options.zoneName ?? process.env.CLOUDFLARE_ZONE_NAME ?? DEFAULT_ZONE_NAME,
      fetcher
    }));
  const expression = webhookSecurityExceptionExpression({
    host: options.webhookHost ?? process.env.BOT_WEBHOOK_HOST ?? DEFAULT_WEBHOOK_HOST,
    path: options.webhookPath ?? process.env.BOT_WEBHOOK_PATH ?? DEFAULT_WEBHOOK_PATH
  });

  const existing = await getFirewallCustomEntrypoint({ apiToken, zoneId, fetcher });
  const nextRules = upsertWebhookSecurityException(existing?.rules ?? [], expression);
  const body = {
    name: existing?.name ?? "minutesbot custom firewall rules",
    description: existing?.description ?? "Custom WAF rules for minutesbot.",
    kind: existing?.kind ?? "zone",
    phase: existing?.phase ?? FIREWALL_CUSTOM_PHASE,
    rules: nextRules
  };

  await cloudflareRequest<Ruleset>({
    apiToken,
    fetcher,
    method: "PUT",
    path: `/zones/${zoneId}/rulesets/phases/${FIREWALL_CUSTOM_PHASE}/entrypoint`,
    body
  });
  log(`Cloudflare webhook security exception is configured for ${expression}.`);
}

export function webhookSecurityExceptionExpression(input: { host: string; path: string }): string {
  // host and path are interpolated into a WAF expression string, so reject anything that
  // could break out of the quoted literals.
  if (!WEBHOOK_HOST_PATTERN.test(input.host)) {
    throw new Error(`BOT_WEBHOOK_HOST "${input.host}" is invalid: only letters, digits, dots, and hyphens are allowed.`);
  }
  if (!WEBHOOK_PATH_PATTERN.test(input.path)) {
    throw new Error(`BOT_WEBHOOK_PATH "${input.path}" is invalid: only letters, digits, slashes, underscores, dots, and hyphens are allowed.`);
  }
  return `http.host eq "${input.host}" and http.request.uri.path eq "${input.path}" and http.request.method eq "POST"`;
}

export function upsertWebhookSecurityException(rules: RulesetRule[], expression = BOT_WEBHOOK_SECURITY_EXCEPTION_EXPRESSION): RulesetRule[] {
  const exceptionRule: RulesetRule = {
    ref: BOT_WEBHOOK_SECURITY_EXCEPTION_REF,
    description: "Skip Cloudflare browser and WAF challenges for signed meeting bot webhook POSTs only.",
    expression,
    action: "skip",
    action_parameters: {
      ruleset: "current",
      phases: ["http_request_firewall_managed", "http_request_sbfm"],
      products: ["bic", "securityLevel", "uaBlock", "waf"]
    },
    enabled: true
  };
  return [exceptionRule, ...rules.filter((rule) => rule.ref !== BOT_WEBHOOK_SECURITY_EXCEPTION_REF)];
}

export const ATTENDEE_WEBHOOK_SECURITY_EXCEPTION_REF = BOT_WEBHOOK_SECURITY_EXCEPTION_REF;
export const ATTENDEE_WEBHOOK_SECURITY_EXCEPTION_EXPRESSION = BOT_WEBHOOK_SECURITY_EXCEPTION_EXPRESSION;

async function findZoneId(input: { apiToken: string; accountId: string; zoneName: string; fetcher: CloudflareFetch }): Promise<string> {
  const response = await cloudflareRequest<Zone[]>({
    apiToken: input.apiToken,
    fetcher: input.fetcher,
    method: "GET",
    path: `/zones?name=${encodeURIComponent(input.zoneName)}&account.id=${encodeURIComponent(input.accountId)}`
  });
  const zone = response[0];
  if (!zone) throw new Error(`Cloudflare zone ${input.zoneName} was not found in account ${input.accountId}.`);
  return zone.id;
}

async function getFirewallCustomEntrypoint(input: { apiToken: string; zoneId: string; fetcher: CloudflareFetch }): Promise<Ruleset | null> {
  try {
    return await cloudflareRequest<Ruleset>({
      apiToken: input.apiToken,
      fetcher: input.fetcher,
      method: "GET",
      path: `/zones/${input.zoneId}/rulesets/phases/${FIREWALL_CUSTOM_PHASE}/entrypoint`
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found")) return null;
    throw error;
  }
}

async function cloudflareRequest<T>(input: {
  apiToken: string;
  fetcher: CloudflareFetch;
  method: "GET" | "PUT";
  path: string;
  body?: unknown;
}): Promise<T> {
  const response = await input.fetcher(`https://api.cloudflare.com/client/v4${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.apiToken}`,
      ...(input.body ? { "content-type": "application/json" } : {})
    },
    ...(input.body ? { body: JSON.stringify(input.body) } : {})
  });
  const payload = (await response.json()) as CloudflareResponse<T>;
  if (!response.ok || !payload.success) {
    const message = payload.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") || response.statusText;
    throw new Error(`Cloudflare API request failed: ${message}`);
  }
  return payload.result;
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);

if (isCli) {
  ensureWebhookSecurityException().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
