import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B8: a LOCKED account must answer 423 with a countdown on every PIN-gated
// path — never 401 Unauthorized.
//
// The audit flagged "401 Unauthorized" on PIN flows. That was a SESSION 401 from
// a probe whose cached token had been cleared by an earlier 401, not a lockout
// response — so the correct outcome here is NO code change, and a regression test
// that pins the real behaviour.
//
// The existing pinout tests mirror this logic verbatim rather than calling it, so
// they cannot catch a regression in the real functions. These call the REAL
// authService.verifyPin / authService.changePin and the REAL
// pinLockoutService.assertPinAuthorized.
// ---------------------------------------------------------------------------

const PIN = "123456";
const WRONG = "000000";
const USER = "user-1";

const { users, db, logger } = vi.hoisted(() => {
  const users = new Map<
    string,
    { pinHash: string | null; pinFailedAttempts: number; pinLockedUntil: Date | null }
  >();
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { pinHash: string } }) => {
        const row = users.get(where.id);
        if (row) row.pinHash = data.pinHash;
        return row ?? {};
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; pinFailedAttempts?: number };
          data: { pinFailedAttempts?: number; pinLockedUntil?: Date | null };
        }) => {
          const row = users.get(where.id);
          if (!row) return { count: 0 };
          if (
            where.pinFailedAttempts !== undefined &&
            row.pinFailedAttempts !== where.pinFailedAttempts
          ) {
            return { count: 0 };
          }
          if (data.pinFailedAttempts !== undefined) row.pinFailedAttempts = data.pinFailedAttempts;
          if (data.pinLockedUntil !== undefined) row.pinLockedUntil = data.pinLockedUntil;
          return { count: 1 };
        },
      ),
    },
  };
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
  };
  return { users, db, logger };
});

vi.mock("../../config/database.js", () => ({ prisma: db }));
vi.mock("../../config/logger.js", () => ({ logger }));

const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      DEV_VERIFICATION_MODE: false,
      NODE_ENV: "test",
      EMAIL_PROVIDER: "resend",
      OTP_TTL_SECONDS: 900,
      OTP_MAX_ATTEMPTS: 5,
      JWT_SECRET: "test-only-secret-not-used-for-anything-real-32",
      JWT_EXPIRES_IN: "1h",
      OTP_EXPIRY_GRACE_SECONDS: 60,
    },
  },
}));
vi.mock("../../config/env.js", () => ({ env: envState.env }));

vi.mock("../email/index.js", () => ({
  isEmailProviderConfigured: () => true,
  trySendEmail: async () => true,
}));
vi.mock("../email/templates.js", () => ({
  ttlMinutes: () => 15,
  verificationEmailBody: () => ({ html: "", text: "" }),
  verificationEmailSubject: () => "code",
}));
vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("./verificationCodeStore.js", () => ({
  createVerificationCode: async () => "123456",
  consumeVerificationCode: async () => "ok",
  recordVerificationFailure: async () => 0,
  getVerificationTtlSeconds: () => 900,
}));

import { authService } from "./auth.service.js";
import { pinLockoutService } from "./pinLockout.service.js";

/** Captures the status code an operation actually produces. */
async function status(fn: () => Promise<unknown>): Promise<number | "no-throw" | "no-statusCode"> {
  try {
    await fn();
    return "no-throw";
  } catch (err) {
    return (err as { statusCode?: number }).statusCode ?? "no-statusCode";
  }
}

async function message(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

beforeEach(async () => {
  users.clear();
  users.set(USER, {
    pinHash: await bcrypt.hash(PIN, 10),
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  });
  logger.warn.mockClear();
  logger.info.mockClear();
  logger.error.mockClear();
});

/** Arms the lock exactly as a real brute force would: five wrong PINs. */
async function lockTheAccount(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await status(() => authService.verifyPin(USER, WRONG));
  }
  const row = users.get(USER)!;
  // The arming attempt deliberately RESETS the counter to 0 and stamps a fresh
  // window (pinLockout.recordFailure, the "isLockingAttempt" branch), so the
  // count being 0 here is correct and is what stops a concurrent burst from
  // walking straight past the threshold.
  expect(row.pinFailedAttempts).toBe(0);
  expect(row.pinLockedUntil).not.toBeNull();
  expect(row.pinLockedUntil!.getTime()).toBeGreaterThan(Date.now());
}

describe("B8: every PIN-gated path answers 423 while locked", () => {
  it("login / verify-pin -> 423, not 401", async () => {
    await lockTheAccount();
    expect(await status(() => authService.verifyPin(USER, PIN))).toBe(423);
  });

  it("change-pin -> 423, not 401", async () => {
    await lockTheAccount();
    expect(await status(() => authService.changePin(USER, PIN, "654321"))).toBe(423);
  });

  it("transfer gate -> 423, not 401, even with the CORRECT pin", async () => {
    await lockTheAccount();
    expect(await status(() => pinLockoutService.assertPinAuthorized(USER, PIN, "transfer"))).toBe(423);
  });

  it("transfer gate -> 423 with a wrong pin too", async () => {
    await lockTheAccount();
    expect(await status(() => pinLockoutService.assertPinAuthorized(USER, WRONG, "transfer"))).toBe(423);
  });

  it("no path answers 401 while locked", async () => {
    await lockTheAccount();
    const observed = [
      await status(() => authService.verifyPin(USER, PIN)),
      await status(() => authService.changePin(USER, PIN, "654321")),
      await status(() => pinLockoutService.assertPinAuthorized(USER, PIN, "transfer")),
      await status(() => pinLockoutService.assertPinAuthorized(USER, WRONG, "transfer")),
    ];
    expect(observed).toEqual([423, 423, 423, 423]);
    expect(observed).not.toContain(401);
    expect(observed).not.toContain(409);
  });

  it("every locked response carries the countdown", async () => {
    await lockTheAccount();
    for (const fn of [
      () => authService.verifyPin(USER, PIN),
      () => authService.changePin(USER, PIN, "654321"),
      () => pinLockoutService.assertPinAuthorized(USER, PIN, "transfer"),
    ]) {
      expect(await message(fn)).toMatch(/Too many incorrect PIN attempts\. Try again in \d+ minutes?\./);
    }
  });

  it("the countdown shrinks as the lock expires", async () => {
    await lockTheAccount();
    // 30s remaining: Math.ceil(30000/60000) === 1, and the message must use the
    // SINGULAR "minute". 61s would round up to 2, which is why this is 30.
    users.get(USER)!.pinLockedUntil = new Date(Date.now() + 30_000);
    expect(await message(() => authService.verifyPin(USER, PIN))).toMatch(/in 1 minute\./);
    users.get(USER)!.pinLockedUntil = new Date(Date.now() + 16 * 60_000);
    expect(await message(() => authService.verifyPin(USER, PIN))).toMatch(/in 16 minutes\./);
  });

  it("a locked attempt does not advance the counter further", async () => {
    await lockTheAccount();
    const before = users.get(USER)!.pinFailedAttempts;
    await status(() => authService.verifyPin(USER, WRONG));
    expect(users.get(USER)!.pinFailedAttempts).toBe(before);
  });

  it("emits a security event for the attempt during lockout", async () => {
    await lockTheAccount();
    logger.warn.mockClear();
    logger.info.mockClear();
    await status(() => authService.verifyPin(USER, PIN));
    const logged = [...logger.warn.mock.calls, ...logger.info.mock.calls]
      .map((c) => JSON.stringify(c))
      .join("\n");
    expect(logged).toMatch(/lockout/i);
  });
});

describe("B8: ordinary wrong-PIN status codes are preserved", () => {
  it("a wrong PIN while NOT locked is still 401", async () => {
    expect(await status(() => authService.verifyPin(USER, WRONG))).toBe(401);
  });

  it("a wrong PIN while NOT locked does not mention a lockout", async () => {
    const text = await message(() => authService.verifyPin(USER, WRONG));
    expect(text).toMatch(/Incorrect PIN/i);
    expect(text).not.toMatch(/Too many/);
  });

  it("a wrong transfer PIN while NOT locked is still 401", async () => {
    expect(await status(() => pinLockoutService.assertPinAuthorized(USER, WRONG, "transfer"))).toBe(401);
  });

  it("the correct PIN while NOT locked succeeds", async () => {
    expect(await status(() => authService.verifyPin(USER, PIN))).toBe("no-throw");
    expect(await status(() => pinLockoutService.assertPinAuthorized(USER, PIN, "transfer"))).toBe("no-throw");
  });

  it("a malformed PIN is still a 400, locked or not", async () => {
    expect(await status(() => authService.verifyPin(USER, "12ab"))).toBe(400);
    await lockTheAccount();
    expect(await status(() => authService.verifyPin(USER, "12ab"))).toBe(400);
  });

  it("an account with no PIN is still a 409, locked or not", async () => {
    users.set(USER, { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null });
    expect(await status(() => authService.verifyPin(USER, PIN))).toBe(409);
  });

  it("the lock expires and the correct PIN works again", async () => {
    await lockTheAccount();
    users.get(USER)!.pinLockedUntil = new Date(Date.now() - 1_000);
    expect(await status(() => authService.verifyPin(USER, PIN))).toBe("no-throw");
  });

  it("a successful PIN resets the counter", async () => {
    await status(() => authService.verifyPin(USER, WRONG));
    await status(() => authService.verifyPin(USER, WRONG));
    expect(users.get(USER)!.pinFailedAttempts).toBe(2);
    expect(await status(() => authService.verifyPin(USER, PIN))).toBe("no-throw");
    expect(users.get(USER)!.pinFailedAttempts).toBe(0);
  });
});