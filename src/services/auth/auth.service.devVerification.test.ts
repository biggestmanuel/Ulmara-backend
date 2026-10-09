import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B1. The verification-code bypass must actually BYPASS, and must be impossible
// to enable in production.
//
// `issueAndDeliverCode` previously checked that the email provider was
// configured BEFORE looking at DEV_VERIFICATION_MODE, so with the flag on and no
// credentials it still returned 503 and no devCode — the flag could not do the
// one thing it exists to do.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  devMode: true,
  nodeEnv: "development",
  providerConfigured: false,
  sendEmail: vi.fn(async (_to: string, _subject: string, _html: string, _text: string) => true),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  // Each signup needs a distinct email, or the second call is a legitimate 409
  // and the test measures the duplicate check instead of the bypass.
  nextEmail: 0,
  emails: [] as string[],
}));

vi.mock("../../config/env.js", () => ({
  get env() {
    return {
      get DEV_VERIFICATION_MODE() { return state.devMode; },
      get NODE_ENV() { return state.nodeEnv; },
      EMAIL_PROVIDER: "resend",
      OTP_TTL_SECONDS: 900,
      OTP_MAX_ATTEMPTS: 5,
      // signup() ends by signing a session token, and verificationCodeStore
      // keys its HMAC on this, so both must be present for the code under test
      // to be reached at all.
      JWT_SECRET: "test-only-secret-not-used-for-anything-real-32",
      JWT_EXPIRES_IN: "1h",
      JWT_PREVIOUS_SECRET: undefined,
      JWT_PREVIOUS_SECRET_RETIRE_AT: undefined,
      OTP_EXPIRY_GRACE_SECONDS: 60,
    };
  },
  assertEmailProviderConfigured: () => undefined,
  assertRampProviderConfigured: () => undefined,
}));

vi.mock("../../config/logger.js", () => {
  const logger: Record<string, unknown> = {
    fatal: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn(),
    error: (...a: unknown[]) => state.error(...a),
    warn: (...a: unknown[]) => state.warn(...a),
    info: (...a: unknown[]) => state.info(...a),
  };
  return { logger };
});

vi.mock("../../config/database.js", () => ({
  prisma: {
    user: {
      // findUnique is used for BOTH the duplicate-email check and the
      // resendCode lookup, so it has to answer per email rather than always
      // returning a user.
      findUnique: vi.fn(async (args: { where: { email?: string; id?: string } }) => {
        if (args.where.email) {
          if (state.emails.includes(args.where.email)) {
            return { id: "u-1", email: args.where.email };
          }
          return null;
        }
        return { id: args.where.id ?? "u-1", email: "a@b.test" };
      }),
      create: vi.fn(async (args: { data: { email: string } }) => {
        state.emails.push(args.data.email);
        return { id: `u-${state.emails.length}`, ...args.data, emailVerified: false, phoneVerified: false };
      }),
      update: vi.fn(async () => ({})),
    },
    session: { create: vi.fn(async () => ({ id: "s-1" })) },
  },
  connectDatabase: vi.fn(), disconnectDatabase: vi.fn(),
}));

vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("./verificationCodeStore.js", () => ({
  createVerificationCode: vi.fn(async () => "123456"),
  consumeVerificationCode: vi.fn(async () => "ok"),
  recordVerificationFailure: vi.fn(async () => 0),
  getVerificationTtlSeconds: vi.fn(() => 900),
}));
vi.mock("../email/index.js", () => ({
  isEmailProviderConfigured: () => state.providerConfigured,
  trySendEmail: (to: string, subject: string, html: string, text: string) =>
    state.sendEmail(to, subject, html, text),
}));
vi.mock("../email/templates.js", () => ({
  // ttlMinutes must be present too: auth.service imports it alongside the
  // body/subject builders, and a mocked module missing an export turns the
  // send path into a TypeError that reads as "the provider was never called".
  ttlMinutes: () => 15,
  verificationEmailBody: () => ({ html: "<p>c</p>", text: "c" }),
  verificationEmailSubject: (code: string) => `code ${code}`,
}));

import { authService } from "./auth.service.js";

beforeEach(() => {
  state.devMode = true;
  state.nodeEnv = "development";
  state.providerConfigured = false;
  state.sendEmail.mockClear();
  state.sendEmail.mockResolvedValue(true);
  state.warn.mockClear();
  state.error.mockClear();
  state.emails = [];
  state.nextEmail = 0;
});

/** A fresh email per call, so no test trips the duplicate-email 409. */
const freshEmail = (): string => `b1-${++state.nextEmail}@b.test`;

afterEach(() => { vi.clearAllMocks(); });

describe("B1: DEV_VERIFICATION_MODE in development", () => {
  it("returns devVerificationCodes even with NO email provider configured", async () => {
    state.providerConfigured = false;
    const result = await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(result.devVerificationCodes).toBeDefined();
    expect(result.devVerificationCodes?.email).toBe("123456");
  });

  it("does not call the email provider at all (delivery is skipped, not tolerated)", async () => {
    state.providerConfigured = true;
    await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it("logs the code", async () => {
    await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    const logged = state.warn.mock.calls.map((c) => JSON.stringify(c)).join("\n");
    expect(logged).toContain("dev_verification_code");
    expect(logged).toContain("123456");
  });

  it("resendCode returns devCode with no provider", async () => {
    const result = await authService.resendVerificationCode("u-1", "email");
    expect(result.devCode).toBe("123456");
  });
});

/** Everything passed to logger.error, flattened for substring assertions. */
const errorLog = (): string =>
  state.error.mock.calls.map((c) => JSON.stringify(c)).join("\n");

describe("B1: with the flag OFF, provider behaviour is unchanged", () => {
  // signup deliberately does NOT fail when delivery fails: the account exists
  // by then and the user can retry from "Resend code". So the 503/502 are
  // observable as a logged error event plus an absent devCode, not as a
  // rejection. resendVerificationCode is the path that does surface them.
  it("surfaces the 503 when the provider is unconfigured, and logs why", async () => {
    state.devMode = false;
    state.providerConfigured = false;
    const result = await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(result.devVerificationCodes).toBeUndefined();
    expect(errorLog()).toContain("email_provider_unavailable");
    expect(errorLog()).toContain("no credentials");
    expect(state.sendEmail).not.toHaveBeenCalled();
  });

  it("surfaces the 503 from resend, where it is not swallowed", async () => {
    state.devMode = false;
    state.providerConfigured = false;
    await expect(
      authService.resendVerificationCode("u-1", "email"),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("sends through the provider and returns NO devCode", async () => {
    state.devMode = false;
    state.providerConfigured = true;
    state.sendEmail.mockResolvedValue(true);
    const result = await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(state.sendEmail).toHaveBeenCalledTimes(1);
    expect(result.devVerificationCodes).toBeUndefined();
  });

  it("502s when the provider rejects the send, and never leaks the code", async () => {
    state.devMode = false;
    state.providerConfigured = true;
    state.sendEmail.mockResolvedValue(false);
    const result = await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(result.devVerificationCodes).toBeUndefined();
    expect(errorLog()).toContain("signup_verification_email_failed");
    // The dropped code must not appear anywhere in the response or the log.
    expect(JSON.stringify(result)).not.toContain("123456");
  });
});

describe("B1: production must not honour the flag", () => {
  // devVerificationEnabled() gates on NODE_ENV, so production with the flag on
  // takes the normal provider path and never returns a code.
  it("ignores the flag: no devCode, and the provider is still used", async () => {
    state.devMode = true;
    state.nodeEnv = "production";
    state.providerConfigured = true;
    const result = await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(result.devVerificationCodes).toBeUndefined();
    expect(state.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("ignores the flag for resend too: no devCode", async () => {
    state.devMode = true;
    state.nodeEnv = "production";
    state.providerConfigured = true;
    const result = await authService.resendVerificationCode("u-1", "email");
    expect(result.devCode).toBeUndefined();
    expect(state.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("503s in production when the provider is unconfigured, flag or not", async () => {
    state.devMode = true;
    state.nodeEnv = "production";
    state.providerConfigured = false;
    const result = await authService.signup({ email: freshEmail(), password: "AuditPassw0rd!23" });
    expect(result.devVerificationCodes).toBeUndefined();
    expect(errorLog()).toContain("email_provider_unavailable");
    await expect(
      authService.resendVerificationCode("u-1", "email"),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
