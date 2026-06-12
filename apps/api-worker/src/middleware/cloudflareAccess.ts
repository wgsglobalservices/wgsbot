import { AppError } from "@minutesbot/shared";
import type { Env } from "../env";

type AccessJwtHeader = {
  alg?: string;
  kid?: string;
};

type AccessJwtPayload = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
};

type JwksResponse = {
  keys?: AccessJwk[];
};

type VerifyOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
};

type AccessJwk = JsonWebKey & {
  kid?: string;
};

let jwksCache: { url: string; keys: AccessJwk[]; expiresAt: number } | null = null;

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export function isCloudflareAccessConfigured(env: Pick<Env, "CLOUDFLARE_ACCESS_AUD" | "CLOUDFLARE_ACCESS_JWKS_URL">): boolean {
  return Boolean(env.CLOUDFLARE_ACCESS_AUD || env.CLOUDFLARE_ACCESS_JWKS_URL);
}

export async function requireCloudflareAccess(
  request: Request,
  env: Pick<Env, "CLOUDFLARE_ACCESS_AUD" | "CLOUDFLARE_ACCESS_JWKS_URL" | "CLOUDFLARE_ACCESS_ISSUER">,
  options: VerifyOptions = {}
): Promise<void> {
  if (!env.CLOUDFLARE_ACCESS_AUD || !env.CLOUDFLARE_ACCESS_JWKS_URL) {
    throw new AppError(
      "ACCESS_CONFIG_MISSING",
      "Configure CLOUDFLARE_ACCESS_AUD and CLOUDFLARE_ACCESS_JWKS_URL before enabling Cloudflare Access validation.",
      503
    );
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new AppError("ACCESS_JWT_MISSING", "Missing Cloudflare Access JWT.", 403);

  const valid = await verifyCloudflareAccessJwt({
    token,
    audience: env.CLOUDFLARE_ACCESS_AUD,
    issuer: env.CLOUDFLARE_ACCESS_ISSUER || new URL(env.CLOUDFLARE_ACCESS_JWKS_URL).origin,
    jwksUrl: env.CLOUDFLARE_ACCESS_JWKS_URL,
    fetcher: options.fetcher,
    now: options.now
  });

  if (!valid) throw new AppError("ACCESS_JWT_INVALID", "Invalid Cloudflare Access JWT.", 403);
}

export async function verifyCloudflareAccessJwt(input: {
  token: string;
  audience: string;
  issuer: string;
  jwksUrl: string;
  fetcher?: typeof fetch;
  now?: () => number;
}): Promise<boolean> {
  const parts = input.token.split(".");
  if (parts.length !== 3) return false;

  const header = parseJwtPart<AccessJwtHeader>(parts[0]);
  const payload = parseJwtPart<AccessJwtPayload>(parts[1]);
  if (!header || !payload || header.alg !== "RS256") return false;
  if (payload.iss !== input.issuer) return false;
  if (!audienceMatches(payload.aud, input.audience)) return false;

  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSeconds - CLOCK_SKEW_SECONDS) return false;
  if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS) return false;

  const keys = await getJwks(input.jwksUrl, input.fetcher ?? fetch, input.now);
  const key = keys.find((candidate) => candidate.kid === header.kid) ?? keys.find((candidate) => candidate.kty === "RSA");
  if (!key) return false;

  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      base64UrlToArrayBuffer(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return false;
  }
}

export function clearCloudflareAccessJwksCacheForTests(): void {
  jwksCache = null;
}

async function getJwks(jwksUrl: string, fetcher: typeof fetch, now = Date.now): Promise<AccessJwk[]> {
  const currentTime = now();
  if (jwksCache?.url === jwksUrl && jwksCache.expiresAt > currentTime) return jwksCache.keys;

  const response = await fetcher(jwksUrl);
  if (!response.ok) throw new AppError("ACCESS_JWKS_UNAVAILABLE", "Cloudflare Access JWKS could not be loaded.", 503);

  const body = (await response.json()) as JwksResponse;
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { url: jwksUrl, keys, expiresAt: currentTime + JWKS_CACHE_TTL_MS };
  return keys;
}

function parseJwtPart<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(normalizeBase64Url(value), "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(normalizeBase64Url(value), "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function normalizeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
}

function audienceMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual === "string") return actual === expected;
  if (Array.isArray(actual)) return actual.includes(expected);
  return false;
}
