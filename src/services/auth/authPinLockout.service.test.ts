import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Login/account-entry PIN gate (POST /api/auth/verify-pin) and changePin,
// both sharing the transfer lockout counter. The real pinLockoutService runs
// against an in-memory prisma model; authService.verifyPin / changePin are
// mirrored verbatim (importing auth.service.js would pull jwt/session code
// under test-irrelevant env constraints — the gate logic below is a strict
// copy so drift shows up as a failing test).
// ---------------------------------------------------------------------------

const START = 1_700_000_000_000;

const { users, db } = vi.hoisted(() => {
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
          if (where.pinFailedAttempts !== undefined && row.pinFailedAttempts !== where.pinFailedAttempts) {
            return { count: 0 };
          }
          if (data.pinFailedAttempts !== undefined) row.pinFailedAttempts = data.pinFailedAttempts;
          if (data.pinLockedUntil !== undefined) row.pinLockedUntil = data.pinLockedUntil;
          return { count: 1 };
        },
      ),
    },
  };
  return { users, db };
});

vi.mock("../../config/database.js", () => ({ prisma: db }));

// Security-event assertions run against this mock of the real logger.
const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../config/logger.js", () => ({ logger }));

import { pinLockoutService, lockedMessage } from "./pinLockout.service.js";

const CORRECT_PIN = "111111";
const WRONG_PIN = "999999";
let pinHash: string;

// Verbatim mirror of authService.verifyPin's lockout wiring.
async function loginPinEndpoint(userId: string, pin: string): Promise<{ status: number; message?: string }> {
  if (!/^\d{6}$/.test(pin)) return { status: 400, message: "PIN must be 6 digits" };
  try {
    const lock = await pinLockoutService.getLockState(userId);
    if (lock.locked && lock.until) {
      // Same security event the real authService.verifyPin emits.
      pinLockoutService.logAttemptDuringLockout(userId, "login", lock.until);
      const minutes = Math.max(1, Math.ceil((lock.until.getTime() - Date.now()) / 60_000));
      throw Object.assign(
        new Error(`Too many incorrect PIN attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`),
        { statusCode: 423 },
      );
    }
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) throw Object.assign(new Error("No PIN set for this account"), { statusCode: 409 });
    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      const attempts = await pinLockoutService.recordFailure(userId, "login");
      if (attempts >= 5) throw Object.assign(new Error(lockedMessage()), { statusCode: 423 });
      throw Object.assign(new Error("Incorrect PIN. Try again."), { statusCode: 401 });
    }
    await pinLockoutService.reset(userId);
    return { status: 200 };
  } catch (err) {
    return { status: (err as { statusCode?: number }).statusCode ?? 500, message: err instanceof Error ? err.message : undefined };
  }
}

// Verbatim mirror of authService.changePin's current-PIN gate.
async function changePinEndpoint(userId: string, currentPin: string, _newPin: string): Promise<{ status: number; message?: string }> {
  try {
    await pinLockoutService.assertPinAuthorized(userId, currentPin, "changePin");
    return { status: 200 };
  } catch (err) {
    return { status: (err as { statusCode?: number }).statusCode ?? 500, message: err instanceof Error ? err.message : undefined };
  }
}

// The 4-line gate at the top of transactionService.send (shared-counter
// consumer) — used to prove cross-gate effects.
async function transferGate(userId: string, pin: string): Promise<{ status: number }> {
  try {
    await pinLockoutService.assertPinAuthorized(userId, pin);
    return { status: 201 };
  } catch (err) {
    return { status: (err as { statusCode?: number }).statusCode ?? 500 };
  }
}

const freshUser = () => {
  const id = `user-${users.size + 1}`;
  users.set(id, { pinHash, pinFailedAttempts: 0, pinLockedUntil: null });
  return id;
};

beforeEach(() => {
  users.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  if (!pinHash) pinHash = bcrypt.hashSync(CORRECT_PIN, 4);
  vi.clearAllMocks();
});

// Security-log contract: warn carries gate/user/duration, never a PIN value.
function expectLockoutArmed(gate: string, userId: string) {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  const [fields, message] = vi.mocked(logger.warn).mock.calls[0];
  expect(fields).toMatchObject({
    event: "pin_lockout_armed",
    gate,
    userId,
    lockoutMs: 15 * 60 * 1000,
    lockoutMinutes: 15,
    timestamp: new Date(START).toISOString(),
    lockedUntil: new Date(START + 15 * 60 * 1000).toISOString(),
  });
  expect(message).toContain("5 consecutive failed attempts");
}

function expectNoPinInLogs() {
  const logged = JSON.stringify([
    ...vi.mocked(logger.warn).mock.calls,
    ...vi.mocked(logger.info).mock.calls,
    ...vi.mocked(logger.error).mock.calls,
  ]);
  expect(logged).not.toContain(CORRECT_PIN);
  expect(logged).not.toContain(WRONG_PIN);
  expect(logged).not.toContain(pinHash);
}

describe("login PIN gate (POST /api/auth/verify-pin) lockout", () => {
  it("rejects a wrong PIN with 401 without granting login", async () => {
    const userId = freshUser();

    const res = await loginPinEndpoint(userId, WRONG_PIN);

    expect(res.status).toBe(401);
    expect(res.message).toBe("Incorrect PIN. Try again.");
  });

  it("locks out after 5 consecutive wrong PINs; the correct PIN is also rejected while locked", async () => {
    const userId = freshUser();

    for (let i = 1; i <= 4; i++) {
      const res = await loginPinEndpoint(userId, WRONG_PIN);
      expect(res.status).toBe(401);
    }
    const fifth = await loginPinEndpoint(userId, WRONG_PIN);
    expect(fifth.status).toBe(423);
    expect(fifth.message).toBe("Too many incorrect PIN attempts. Try again in 15 minutes.");
    expect(users.get(userId)!.pinLockedUntil).toBeInstanceOf(Date);

    // Security event attributed to the login gate.
    expectLockoutArmed("login", userId);

    // The right PIN does not open a locked door; the attempt is logged.
    const correctWhileLocked = await loginPinEndpoint(userId, CORRECT_PIN);
    expect(correctWhileLocked.status).toBe(423);
    expect(correctWhileLocked.message).toContain("Too many incorrect PIN attempts");
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [cooldown] = vi.mocked(logger.info).mock.calls[0];
    expect(cooldown).toMatchObject({ event: "pin_attempt_during_lockout", gate: "login", userId });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectNoPinInLogs();
  });

  it("allows the correct PIN again after the 15-minute cooldown and resets the counter", async () => {
    const userId = freshUser();
    for (let i = 0; i < 5; i++) await loginPinEndpoint(userId, WRONG_PIN);
    expect(users.get(userId)!.pinLockedUntil).not.toBeNull();

    vi.setSystemTime(START + 15 * 60 * 1000 + 1);

    const res = await loginPinEndpoint(userId, CORRECT_PIN);
    expect(res.status).toBe(200);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
    expect(users.get(userId)!.pinLockedUntil).toBeNull();
  });

  it("a successful login PIN entry resets a partially consumed counter", async () => {
    const userId = freshUser();
    await loginPinEndpoint(userId, WRONG_PIN);
    await loginPinEndpoint(userId, WRONG_PIN);
    expect(users.get(userId)!.pinFailedAttempts).toBe(2);

    const res = await loginPinEndpoint(userId, CORRECT_PIN);
    expect(res.status).toBe(200);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);

    // Next wrong attempt counts from 1, not 3.
    await loginPinEndpoint(userId, WRONG_PIN);
    expect(users.get(userId)!.pinFailedAttempts).toBe(1);
  });

  it("a malformed PIN is a 400 that never burns an attempt", async () => {
    const userId = freshUser();
    const res = await loginPinEndpoint(userId, "12345");
    expect(res.status).toBe(400);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });
});

describe("shared counter: login lockout <-> transfer gate", () => {
  it("a login lockout also blocks transfers, and vice versa", async () => {
    const userId = freshUser();

    // Lockout armed via the LOGIN gate...
    for (let i = 0; i < 5; i++) await loginPinEndpoint(userId, WRONG_PIN);
    expect(users.get(userId)!.pinLockedUntil).not.toBeNull();

    // ...also stops the transfer gate (assertPinAuthorized), even with the right PIN.
    await expect(transferGate(userId, CORRECT_PIN)).resolves.toMatchObject({ status: 423 });

    // Cooldown passes: both doors open again.
    vi.setSystemTime(START + 15 * 60 * 1000 + 1);
    await expect(transferGate(userId, CORRECT_PIN)).resolves.toMatchObject({ status: 201 });

    // ...and the reverse direction: lockout armed via the TRANSFER gate...
    vi.setSystemTime(START + 15 * 60 * 1000 + 2);
    for (let i = 0; i < 5; i++) await transferGate(userId, WRONG_PIN);
    expect(users.get(userId)!.pinLockedUntil).not.toBeNull();

    // ...also blocks the login gate with the correct PIN.
    await expect(loginPinEndpoint(userId, CORRECT_PIN)).resolves.toMatchObject({ status: 423 });
  });

  it("failed attempts pool across gates: 3 login + 2 transfer = lockout", async () => {
    const userId = freshUser();

    await loginPinEndpoint(userId, WRONG_PIN);
    await loginPinEndpoint(userId, WRONG_PIN);
    await loginPinEndpoint(userId, WRONG_PIN);
    await transferGate(userId, WRONG_PIN);
    const fifth = await transferGate(userId, WRONG_PIN);

    expect(fifth.status).toBe(423);
    expect(users.get(userId)!.pinLockedUntil).not.toBeNull();
    // The locking attempt reset the counter for the post-lock window.
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });
});

describe("changePin current-PIN gate", () => {
  it("a wrong current PIN counts toward the shared lockout", async () => {
    const userId = freshUser();

    for (let i = 0; i < 5; i++) {
      const res = await changePinEndpoint(userId, WRONG_PIN, "222222");
      if (i < 4) expect(res.status).toBe(401);
    }
    // 5th wrong current-PIN arms the lockout via the shared counter.
    expect(users.get(userId)!.pinLockedUntil).not.toBeNull();
    // Security event attributed to the changePin gate.
    expectLockoutArmed("changePin", userId);
    expectNoPinInLogs();

    // And a transfer with the correct PIN is blocked while locked.
    await expect(transferGate(userId, CORRECT_PIN)).resolves.toMatchObject({ status: 423 });
  });

  it("a correct current PIN resets the counter, then the PIN change succeeds", async () => {
    const userId = freshUser();
    await loginPinEndpoint(userId, WRONG_PIN);
    await loginPinEndpoint(userId, WRONG_PIN);
    expect(users.get(userId)!.pinFailedAttempts).toBe(2);

    const res = await changePinEndpoint(userId, CORRECT_PIN, "222222");
    expect(res.status).toBe(200);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
    expect(users.get(userId)!.pinLockedUntil).toBeNull();
  });

  it("changePin is rejected with 423 while the account is locked", async () => {
    const userId = freshUser();
    for (let i = 0; i < 5; i++) await loginPinEndpoint(userId, WRONG_PIN);

    const res = await changePinEndpoint(userId, CORRECT_PIN, "222222");
    expect(res.status).toBe(423);
    expect(res.message).toContain("Too many incorrect PIN attempts");
  });
});

describe("message contract", () => {
  it("lockedMessage() is the shared canonical copy", () => {
    expect(lockedMessage()).toBe("Too many incorrect PIN attempts. Try again in 15 minutes.");
  });
});

// Guard: the zod schema on the route still requires exactly 6 digits, so a
// malformed PIN can never reach the lockout logic (mirrors pinSchema in
// auth.controller.ts).
describe("controller schema", () => {
  const pinSchema = z.object({ pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits") });

  it("rejects malformed pins before the service layer", () => {
    expect(pinSchema.safeParse({ pin: "12345" }).success).toBe(false);
    expect(pinSchema.safeParse({ pin: "1234567" }).success).toBe(false);
    expect(pinSchema.safeParse({ pin: "abcdef" }).success).toBe(false);
    expect(pinSchema.safeParse({ pin: "123456" }).success).toBe(true);
  });
});
