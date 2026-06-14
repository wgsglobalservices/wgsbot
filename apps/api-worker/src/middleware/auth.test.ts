import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@minutesbot/shared";
import { adminTokenAuthMiddleware, createAuthMiddleware, isPublicApiPath } from "./auth";
import { clearCloudflareAccessJwksCacheForTests, verifyCloudflareAccessJwt } from "./cloudflareAccess";

const ACCESS_AUD = "13f67694a98579897f6175043bb595df17afdfd5129d44c33e8b937b5576ae71";
const ACCESS_ISSUER = "https://example.cloudflareaccess.com";
const ACCESS_JWKS_URL = "https://example.cloudflareaccess.com/cdn-cgi/access/certs";

describe("auth middleware", () => {
  afterEach(() => {
    clearCloudflareAccessJwksCacheForTests();
  });

  it("leaves health and meeting bot webhook routes public", () => {
    expect(isPublicApiPath("/api/health")).toBe(true);
    expect(isPublicApiPath("/api/webhooks/bot")).toBe(true);
    expect(isPublicApiPath("/api/ready")).toBe(true);
    expect(isPublicApiPath("/api/settings")).toBe(false);
  });

  it("allows requests with the configured admin token", async () => {
    const next = vi.fn();
    const middleware = createAuthMiddleware();

    await middleware(
      ({
        req: {
          path: "/api/settings",
          raw: new Request("https://app.example.com/api/settings", { headers: { authorization: "Bearer secret-token" } })
        },
        env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com" }
      } as any),
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it("allows requests with a valid Cloudflare Access JWT when Access is configured", async () => {
    const next = vi.fn();
    const { token, jwk } = await createAccessJwt();
    const middleware = createAuthMiddleware({
      fetchAccessJwks: async () => Response.json({ keys: [jwk] }),
      now: () => 1_700_000_000_000
    });

    await middleware(
      ({
        req: {
          path: "/api/settings",
          raw: new Request("https://app.example.com/api/settings", { headers: { "cf-access-jwt-assertion": token } })
        },
        env: {
          APP_BASE_URL: "https://app.example.com",
          CLOUDFLARE_ACCESS_AUD: ACCESS_AUD,
          CLOUDFLARE_ACCESS_JWKS_URL: ACCESS_JWKS_URL
        }
      } as any),
      next
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects protected routes when Access is configured but the JWT is missing", async () => {
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings") },
          env: {
            APP_BASE_URL: "https://app.example.com",
            CLOUDFLARE_ACCESS_AUD: ACCESS_AUD,
            CLOUDFLARE_ACCESS_JWKS_URL: ACCESS_JWKS_URL
          }
        } as any),
        vi.fn()
      )
    ).rejects.toMatchObject(new AppError("ACCESS_JWT_MISSING", "Missing Cloudflare Access JWT.", 403));
  });

  it("rejects Access JWTs for the wrong audience", async () => {
    const { token, jwk } = await createAccessJwt({ aud: "other-audience" });

    await expect(
      verifyCloudflareAccessJwt({
        token,
        audience: ACCESS_AUD,
        issuer: ACCESS_ISSUER,
        jwksUrl: ACCESS_JWKS_URL,
        fetcher: async () => Response.json({ keys: [jwk] }),
        now: () => 1_700_000_000_000
      })
    ).resolves.toBe(false);
  });

  it("rejects protected routes when the admin token secret is not configured", async () => {
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings") },
          env: { APP_BASE_URL: "https://app.example.com" }
        } as any),
        vi.fn()
      )
    ).rejects.toMatchObject(new AppError("AUTH_NOT_CONFIGURED", "Configure SESSION_SECRET before exposing admin routes.", 503));
  });

  it("requires Cloudflare Access for production admin routes unless break-glass token auth is explicitly enabled", async () => {
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings", { headers: { authorization: "Bearer secret-token" } }) },
          env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com", ENVIRONMENT: "production" }
        } as any),
        vi.fn()
      )
    ).rejects.toMatchObject(new AppError("CLOUDFLARE_ACCESS_REQUIRED", "Configure Cloudflare Access before exposing production admin routes.", 503));

    const next = vi.fn();
    await middleware(
      ({
        req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings", { headers: { authorization: "Bearer secret-token" } }) },
        env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com", ENVIRONMENT: "production", ALLOW_ADMIN_TOKEN_AUTH: "true" }
      } as any),
      next
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects requests without the configured admin token", async () => {
    const middleware = createAuthMiddleware();

    await expect(
      middleware(
        ({
          req: { path: "/api/settings", raw: new Request("https://app.example.com/api/settings") },
          env: { SESSION_SECRET: "secret-token", APP_BASE_URL: "https://app.example.com" }
        } as any),
        vi.fn()
      )
    ).rejects.toMatchObject(new AppError("UNAUTHORIZED", "Enter the admin token to access minutesbot.", 401));
  });

  it("exports the default admin token middleware", () => {
    expect(adminTokenAuthMiddleware).toBeTypeOf("function");
  });
});

async function createAccessJwt(overrides: Record<string, unknown> = {}): Promise<{ token: string; jwk: JsonWebKey }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid?: string };
  jwk.alg = "RS256";
  jwk.kid = "test-key";
  jwk.use = "sig";

  const header = base64Url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: ACCESS_ISSUER,
      aud: ACCESS_AUD,
      exp: 1_700_003_600,
      ...overrides
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(signingInput));
  return { token: `${signingInput}.${base64Url(new Uint8Array(signature))}`, jwk };
}

function base64Url(value: string | Uint8Array): string {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
