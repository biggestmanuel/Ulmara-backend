import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

/**
 * Security-event logging audit (Section 5).
 *
 * This file deliberately MIRRORS the real gates instead of importing the
 * services, because importing transaction.service would pull in BullMQ and the
 * chain adapters (which open live connections). The mirrored `assertPinAuthorized`
 * below is a verbatim copy of the real implementation's contract, and the
 * assertions are about what the real logger receives.
 */
const { users, db, freshUser, advanceMs } = vi.hoisted(() => {
  interface UserRow {
    pinHash: string | null;
    pinFailedAttempts: number;
    pinLockedUntil: number | null;
  }
  const users = new Map<string, UserRow>();
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        if (!row) return null;
        return {
          pinHash: row.pinHash,
          pinFailedAttempts: row.pinFailedAttempts,
          pinLockedUntil: row.pinLockedUntil === null ? null : new Date(row.pinLockedUntil),
        };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; pinFailedAttempts?: number }; data: Record<string, unknown> }) => {
        const row = users.get(where.id);
        if (!row) return { count: 0 };
        if (where.pinFailedAttempts !== undefined && row.pinFailedAttempts !== where.pinFailedAttempts) return { count: 0 };
        if (data.pinFailedAttempts !== undefined) row.pinFailedAttempts = data.pinFailedAttempts as number;
        if (data.pinLockedUntil !== undefined) {
          row.pinLockedUntil =
            data.pinLockedUntil === null
              ? null
              : data.pinLockedUntil instanceof Date
                ? data.pinLockedUntil.getTime()
                : (data.pinLockedUntil as number);
        }
        return { count: 1 };
      }),
    },
  };
  return {
    users,
    db,
    freshUser: (over: Partial<UserRow> = {}) => {
      const id = `user-${users.size + 1}`;
      users.set(id, { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null, ...over });
      return id;
    },
    advanceMs: (ms: number) => vi.setSystemTime(vi.getMockedSystemTime()!.getTime() + ms),
  };
});

// NOTE: this test file lives in src/services/auth/, so the config modules are
// two levels up. `../config/...` would resolve to a non-existent path, leaving
// the REAL prisma client and the REAL pino logger in place.
vi.mock("../../config/database.js", () => ({ prisma: db }));

const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../config/logger.js", () => ({ logger }));

import { pinLockoutService, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MS } from "./pinLockout.service.js";

const CORRECT_PIN = "123456";
const WRONG_PIN = "654321";
// Hashed ONCE with the real bcrypt (cost 4 keeps it fast) via the SYNCHRONOUS
// API: an async hash never resolves under these fake timers, and the real
// compare path still exercises genuine bcrypt.
let correctPinHash: string;

beforeEach(() => {
  users.clear();
  vi.useFakeTimers({ toFake: ["Date"] }); // Date only: bcrypt needs real timers
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  if (!correctPinHash) {
    // Real bcrypt, hashed ONCE with the SYNCHRONOUS API: an async hash never
    // resolves under these fake timers. The compare path in the service still
    // runs genuine bcrypt.
    correctPinHash = bcrypt.hashSync(CORRECT_PIN, 4);
  }
  vi.clearAllMocks();
});

/** Everything ever written to any log level, as one searchable string. */
function allLogs(): string {
  return JSON.stringify([
    ...vi.mocked(logger.warn).mock.calls,
    ...vi.mocked(logger.info).mock.calls,
    ...vi.mocked(logger.error).mock.calls,
    ...vi.mocked(logger.debug).mock.calls,
    ...vi.mocked(logger.trace).mock.calls,
    ...vi.mocked(logger.fatal).mock.calls,
  ]);
}

describe("Section 5: lockout arming produces a WARNING", () => {
  it("emits exactly one warn-level event with the expected fields", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }

    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [fields, message] = vi.mocked(logger.warn).mock.calls[0];
    expect(fields).toMatchObject({
      event: "pin_lockout_armed",
      gate: "transfer",
      userId,
      lockoutMs: PIN_LOCKOUT_MS,
      lockoutMinutes: 15,
    });
    expect(fields.timestamp).toBe(new Date("2026-01-01T00:00:00Z").toISOString());
    expect(message).toContain("5 consecutive failed attempts");
  });

  it("attributes the event to the gate that hit the limit", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "login").catch(() => undefined);
    }
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatchObject({ event: "pin_lockout_armed", gate: "login" });
  });

  it("fires once per lockout, not once per attempt", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS + 3; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    expect(vi.mocked(logger.warn).mock.calls.filter((c) => (c[0] as { event?: string }).event === "pin_lockout_armed"))
      .toHaveLength(1);
  });

  it("fires again after the cooldown expires and the PIN is wrong again", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    advanceMs(PIN_LOCKOUT_MS + 1);
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    expect(vi.mocked(logger.warn).mock.calls.filter((c) => (c[0] as { event?: string }).event === "pin_lockout_armed"))
      .toHaveLength(2);
  });
});

describe("Section 5: attempts during cooldown are logged", () => {
  it("logs one event per rejected attempt while locked", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    vi.mocked(logger.info).mockClear();

    // Three more attempts during the cooldown.
    for (let i = 0; i < 3; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(3);
    for (const [fields] of vi.mocked(logger.info).mock.calls) {
      expect(fields).toMatchObject({ event: "pin_attempt_during_lockout", gate: "transfer", userId });
    }
  });

  it("does not burn attempt state during the cooldown", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    const lockedUntil = users.get(userId)!.pinLockedUntil;
    for (let i = 0; i < 5; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    expect(users.get(userId)!.pinLockedUntil).toBe(lockedUntil);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });

  it("logs the even-CORRECT pin being rejected during the cooldown", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    vi.mocked(logger.info).mockClear();
    // The lockout is absolute: the right PIN is refused, and that is logged.
    await expect(pinLockoutService.assertPinAuthorized(userId, CORRECT_PIN, "transfer")).rejects.toMatchObject({
      statusCode: 423,
    });
    expect(vi.mocked(logger.info).mock.calls[0][0]).toMatchObject({ event: "pin_attempt_during_lockout" });
  });
});

describe("Section 5: no secret ever reaches a log line", () => {
  it("leaks neither the PIN value nor its hash", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    await pinLockoutService.assertPinAuthorized(userId, CORRECT_PIN, "transfer").catch(() => undefined);
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    for (let i = 0; i < 3; i++) {
      await pinLockoutService.assertPinAuthorized(userId, CORRECT_PIN, "login").catch(() => undefined);
    }

    const logs = allLogs();
    expect(logs).not.toContain(CORRECT_PIN);
    expect(logs).not.toContain(WRONG_PIN);
    expect(logs).not.toContain(correctPinHash);
    // bcrypt hash markers would indicate a hash leaking in any form.
    expect(logs).not.toContain("$2a$");
    expect(logs).not.toContain("$2b$");
  });

  it("logs no field that could carry a credential", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    const everyField = [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.info).mock.calls]
      .flatMap(([fields]) => Object.keys(fields as object));
    for (const key of everyField) {
      expect(key, `unexpected log field: ${key}`).not.toMatch(
        /pin|password|secret|token|jwt|hash|mnemonic|seed|privatekey|authorization|cookie/i,
      );
    }
  });

  it("logs the userId, which is an internal opaque id and not a credential", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    expect(allLogs()).toContain(userId);
  });
});

describe("Section 5: changePin and login share the same counter and the same events", () => {
  it("arms the lockout through the changePin gate too", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "changePin").catch(() => undefined);
    }
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatchObject({ event: "pin_lockout_armed", gate: "changePin" });
  });

  it("a brute-force via one gate locks the other gate out (shared counter)", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    // Burn the budget through the login gate.
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "login").catch(() => undefined);
    }
    // The transfer gate must now also refuse — same User.pinHash.
    await expect(pinLockoutService.assertPinAuthorized(userId, CORRECT_PIN, "transfer")).rejects.toMatchObject({
      statusCode: 423,
    });
  });
});

describe("Section 5: concurrency keeps the event count exact", () => {
  it("emits ONE arming event even when a burst of failures races", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    // Ten simultaneous wrong attempts against a 5-attempt budget. The CAS in
    // recordFailure stops two attempts landing on the same count, and the
    // active-lockout guard stops the overflow attempts from walking the
    // counter on to a SECOND arming event.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined),
      ),
    );

    const arming = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => (c[0] as { event?: string }).event === "pin_lockout_armed");
    expect(arming).toHaveLength(1);

    // And the account really is locked, not merely logged once.
    const lock = await pinLockoutService.getLockState(userId);
    expect(lock.locked).toBe(true);
    expect(lock.until).not.toBeNull();
  });

  it("still answers 423 (not 401) to a racing attempt that slipped past the pre-check", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    // Arm the lockout, then bypass assertPinAuthorized's pre-check by calling
    // recordFailure directly, as a racing in-flight request would.
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    const attempts = await pinLockoutService.recordFailure(userId, "transfer");
    // PIN_MAX_ATTEMPTS signals "locked" to the caller -> a 423.
    expect(attempts).toBe(PIN_MAX_ATTEMPTS);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });

  it("does re-arm after the cooldown has expired", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    advanceMs(PIN_LOCKOUT_MS + 1);
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await pinLockoutService.assertPinAuthorized(userId, WRONG_PIN, "transfer").catch(() => undefined);
    }
    expect(
      vi.mocked(logger.warn).mock.calls.filter((c) => (c[0] as { event?: string }).event === "pin_lockout_armed"),
    ).toHaveLength(2);
  });
});
