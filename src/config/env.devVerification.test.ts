import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B1: DEV_VERIFICATION_MODE must be impossible to enable in production.
//
// This exercises the REAL env module (not a mock) by re-importing it with a
// controlled process.env, because `assertEmailProviderConfigured` reads the
// module-level `env` object that was parsed at import time.
//
// Before the fix, this function began with:
//
//     if (env.NODE_ENV !== "production") return;
//     if (env.DEV_VERIFICATION_MODE) return;
//
// so production + flag-on silently skipped the credential check while leaving
// the flag itself set. Combined with devVerificationEnabled() (which also gates
// on NODE_ENV), that meant a production boot with the flag on skipped delivery
// AND the provider requirement — no way to verify anyone, and no warning.
// ---------------------------------------------------------------------------

/** Baseline: enough env to parse, and valid for a production run. */
const PROD_ENV: Record<string, string> = {
  NODE_ENV: "production",
  DEV_VERIFICATION_MODE: "false",
  DATABASE_URL: "postgresql://u:p@db.invalid:5432/app",
  REDIS_URL: "redis://cache.invalid:6379",
  JWT_SECRET: "test-only-secret-not-used-for-anything-real-32",
  ALLOWED_ORIGINS: "https://ulmara.app",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "test-only-not-a-real-key",
  RAMP_PROVIDER: "bitnob",
  BITNOB_API_KEY: "test-only-not-a-real-key",
  BITNOB_CLIENT_SECRET: "test-only-not-a-real-secret",
  BITNOB_WEBHOOK_SECRET: "test-only-not-a-real-secret",
};

let saved: Record<string, string | undefined>;

/** Re-imports config/env.js with the given environment applied. */
async function loadEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries({ ...PROD_ENV, ...overrides })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // A key set to `undefined` is DELETED, not blanked: the schema rejects an
  // empty string for an optional-but-present var rather than treating it as absent.
  vi.resetModules();
  // Not `return await`: the try/catch-free caller only needs the value, and
  // `return-await` is relaxed for controllers only, not here.
  return import("./env.js");
}

beforeEach(() => {
  saved = {};
  for (const key of Object.keys(PROD_ENV)) saved[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
});

describe("B1: DEV_VERIFICATION_MODE is refused in production", () => {
  it("refuses to boot when production has the flag on", async () => {
    const mod = await loadEnv({ DEV_VERIFICATION_MODE: "true" });
    expect(() => mod.assertEmailProviderConfigured()).toThrow(/DEV_VERIFICATION_MODE/);
    expect(() => mod.assertEmailProviderConfigured()).toThrow(/production/);
  });

  it("the refusal fires even when the provider IS fully configured", async () => {
    // RESEND_API_KEY is present above, so this isolates the flag rule from the
    // credential rule: the flag alone must be enough to stop the boot.
    const mod = await loadEnv({ DEV_VERIFICATION_MODE: "true" });
    expect(mod.env.RESEND_API_KEY).toBeTruthy();
    expect(() => mod.assertEmailProviderConfigured()).toThrow(/DEV_VERIFICATION_MODE/);
  });

  it("boots normally in production with the flag OFF and credentials present", async () => {
    const mod = await loadEnv({ DEV_VERIFICATION_MODE: "false" });
    expect(() => mod.assertEmailProviderConfigured()).not.toThrow();
  });

  it("still enforces the credential requirement in production", async () => {
    // Proves the fix did not simply delete the provider check.
    const mod = await loadEnv({ DEV_VERIFICATION_MODE: "false", RESEND_API_KEY: undefined });
    expect(() => mod.assertEmailProviderConfigured()).toThrow(/RESEND_API_KEY/);
  });

  it("allows the flag in development, where it is the point", async () => {
    const mod = await loadEnv({ NODE_ENV: "development", DEV_VERIFICATION_MODE: "true" });
    expect(mod.env.DEV_VERIFICATION_MODE).toBe(true);
    expect(() => mod.assertEmailProviderConfigured()).not.toThrow();
  });

  it("allows the flag in test", async () => {
    const mod = await loadEnv({ NODE_ENV: "test", DEV_VERIFICATION_MODE: "true" });
    expect(mod.env.DEV_VERIFICATION_MODE).toBe(true);
    expect(() => mod.assertEmailProviderConfigured()).not.toThrow();
  });
});