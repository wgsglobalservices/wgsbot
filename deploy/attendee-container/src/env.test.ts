import { describe, expect, it } from "vitest";
import { buildContainerEnv, isAuthorizedOpsRequest, missingSettings, runtimeStatus } from "./env";

describe("attendee container env", () => {
  it("passes canonical upstream Attendee settings into the container", () => {
    const env = buildContainerEnv({
      DATABASE_URL: "postgres://example",
      REDIS_URL: "rediss://example",
      DJANGO_SECRET_KEY: "django-secret",
      CREDENTIALS_ENCRYPTION_KEY: "fernet-key",
      AWS_RECORDING_STORAGE_BUCKET_NAME: "recordings",
      AWS_ENDPOINT_URL: "https://r2.example",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret"
    });

    expect(env).toMatchObject({
      DJANGO_SETTINGS_MODULE: "attendee.settings.production",
      DATABASE_URL: "postgres://example",
      REDIS_URL: "rediss://example",
      DJANGO_SECRET_KEY: "django-secret",
      CREDENTIALS_ENCRYPTION_KEY: "fernet-key",
      AWS_RECORDING_STORAGE_BUCKET_NAME: "recordings",
      AWS_ENDPOINT_URL: "https://r2.example",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret"
    });
    expect(env).not.toHaveProperty("SECRET_KEY");
    expect(env).not.toHaveProperty("AWS_STORAGE_BUCKET_NAME");
    expect(env).not.toHaveProperty("AWS_S3_ENDPOINT_URL");
  });

  it("bridges legacy secret and storage names to upstream Attendee names", () => {
    const env = buildContainerEnv({
      SECRET_KEY: "legacy-secret",
      AWS_STORAGE_BUCKET_NAME: "legacy-bucket",
      AWS_S3_ENDPOINT_URL: "https://legacy-r2.example"
    });

    expect(env.DJANGO_SECRET_KEY).toBe("legacy-secret");
    expect(env.AWS_RECORDING_STORAGE_BUCKET_NAME).toBe("legacy-bucket");
    expect(env.AWS_ENDPOINT_URL).toBe("https://legacy-r2.example");
  });

  it("reports missing canonical startup settings while honoring legacy secret fallback", () => {
    expect(missingSettings({})).toEqual(["DATABASE_URL", "REDIS_URL", "DJANGO_SECRET_KEY", "CREDENTIALS_ENCRYPTION_KEY"]);
    expect(
      missingSettings({
        DATABASE_URL: "postgres://example",
        REDIS_URL: "redis://example",
        SECRET_KEY: "legacy-secret",
        CREDENTIALS_ENCRYPTION_KEY: "fernet-key"
      })
    ).toEqual([]);
  });

  it("reports runtime status for missing settings", () => {
    expect(
      runtimeStatus({
        DJANGO_SECRET_KEY: "django-secret",
        CREDENTIALS_ENCRYPTION_KEY: "fernet-key"
      })
    ).toEqual({
      ok: false,
      runtime: "cloudflare-containers",
      missing: ["DATABASE_URL", "REDIS_URL"]
    });
  });

  it("reports runtime status ready when required settings are present", () => {
    expect(
      runtimeStatus({
        DATABASE_URL: "postgres://example",
        REDIS_URL: "redis://example",
        DJANGO_SECRET_KEY: "django-secret",
        CREDENTIALS_ENCRYPTION_KEY: "fernet-key"
      })
    ).toEqual({
      ok: true,
      runtime: "cloudflare-containers",
      missing: []
    });
  });

  it("authorizes ops requests only with the configured bearer token", async () => {
    const env = { ATTENDEE_OPS_TOKEN: "ops-secret" };

    await expect(isAuthorizedOpsRequest(new Request("https://attendee.example/_ops/start-workers"), env)).resolves.toBe(false);
    await expect(
      isAuthorizedOpsRequest(new Request("https://attendee.example/_ops/start-workers", { headers: { authorization: "Bearer wrong" } }), env)
    ).resolves.toBe(false);
    await expect(
      isAuthorizedOpsRequest(new Request("https://attendee.example/_ops/start-workers", { headers: { authorization: "Bearer ops-secret" } }), env)
    ).resolves.toBe(true);
  });
});
