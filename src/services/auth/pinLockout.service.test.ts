import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The real pinLockoutService is tested, with prisma swapped for an in-memory
// model of User.pinFailedAttempts / User.pinLockedUntil. The send-path gate
// (the 4-line PIN check at the top of transactionService.send) is mirrored
// verbatim below because importing transaction.service.js would pull in the
// BullMQ/ioredis queue and chain adapters, which open live connections.
// ---------------------------------------------------------------------------

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
      // CAS semantics matching prisma updateMany: guard on the counter value
      // where present, return { count } so the caller can detect races.
      updateMany: vi.fn(async ({
        where,
        data,
      }: {
        where: { id: string; pinFailedAttempts?: number };
        data: { pinFailedAttempts?: number; pinLockedUntil?: Date | number | null };
      }) => {
        const row = users.get(where.id);
        if (!row) return { count: 0 };
        if (where.pinFailedAttempts !== undefined && row.pinFailedAttempts !== where.pinFailedAttempts) {
          return { count: 0 };
        }
        if (data.pinFailedAttempts !== undefined) row.pinFailedAttempts = data.pinFailedAttempts;
        if (data.pinLockedUntil !== undefined) {
          // Production passes Date objects; the model stores epoch numbers.
          row.pinLockedUntil =
            data.pinLockedUntil === null ? null
            : data.pinLockedUntil instanceof Date ? data.pinLockedUntil.getTime()
            : data.pinLockedUntil;
        }
        return { count: 1 };
      }),
    },
  };
  const freshUser = (overrides: Partial<UserRow> = {}) => {
    const id = `user-${users.size + 1}`;
    users.set(id, { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null, ...overrides });
    return id;
  };
  const advanceMs = (ms: number) => {
    vi.setSystemTime(vi.getMockedSystemTime()!.getTime() + ms);
  };
  return { users, db, freshUser, advanceMs };
});

vi.mock("../../config/database.js", () => ({ prisma: db }));

// The real pinLockoutService logs security events through this mock, so the
// tests can assert on the structured fields and scan for PIN leakage.
const { logger } = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../../config/logger.js", () => ({ logger }));

import { pinLockoutService, PIN_MAX_ATTEMPTS, PIN_LOCKOUT_MS } from "./pinLockout.service.js";

const START = 1_700_000_000_000;

// The PIN the "user" knows; hashed once (cost 4 keeps bcrypt fast in tests).
const CORRECT_PIN = "111111";
const WRONG_PIN = "999999";
let correctPinHash: string;

// Mirror of transactionService.send's authorization gate (verbatim order):
// validate pin presence -> server-side PIN verify with lockout -> create tx.
async function sendEndpoint(
  userId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; message?: string; transactionCreated: boolean }> {
  const sendSchema = z.object({
    recipientAccountId: z.string().regex(/^\d{10}$/).optional(),
    recipientAddress: z.string().min(1).max(120).optional(),
    asset: z.string().min(1).max(20),
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    network: z.enum(["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"]),
    pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
  }).refine((v) => Boolean(v.recipientAccountId) !== Boolean(v.recipientAddress), {
    message: "Provide exactly one of recipientAccountId or recipientAddress",
  });

  let parsed: z.infer<typeof sendSchema>;
  try {
    parsed = sendSchema.parse(body);
  } catch {
    return { status: 400, message: "PIN must be 6 digits", transactionCreated: false };
  }

  let transactionCreated = false;
  try {
    if (!parsed.pin) {
      throw Object.assign(new Error("A 6-digit PIN is required to authorize this transfer"), { statusCode: 400 });
    }
    await pinLockoutService.assertPinAuthorized(userId, parsed.pin);
    transactionCreated = true; // prisma.transaction.create happens only past this line
    return { status: 201, transactionCreated };
  } catch (err) {
    const status =
      (err as { statusCode?: number }).statusCode ??
      (err instanceof Error && "statusCode" in err ? 500 : 500);
    return { status, message: err instanceof Error ? err.message : undefined, transactionCreated };
  }
}

const sendBody = (pin?: string) => ({
  recipientAccountId: "1234567890",
  asset: "ETH",
  amount: "1",
  network: "ETH",
  ...(pin !== undefined ? { pin } : {}),
});

beforeEach(() => {
  users.clear();
  vi.useFakeTimers({ toFake: ["Date"] }); // Date only: bcryptjs needs real timers
  vi.setSystemTime(START);
  if (!correctPinHash) correctPinHash = bcrypt.hashSync(CORRECT_PIN, 4);
  // Give every fresh user the same PIN credential.
  for (const row of users.values()) row.pinHash = correctPinHash;
  vi.clearAllMocks();
});

// Security-log contract shared by every lockout path: the warn event carries
// the gate, user id, and lockout duration — and never the PIN value.
function expectLockoutArmed(gate: string, userId: string) {
  expect(logger.warn).toHaveBeenCalledTimes(1);
  const [fields, message] = vi.mocked(logger.warn).mock.calls[0];
  expect(fields).toMatchObject({
    event: "pin_lockout_armed",
    gate,
    userId,
    lockoutMs: PIN_LOCKOUT_MS,
    lockoutMinutes: 15,
    timestamp: new Date(START).toISOString(),
    lockedUntil: new Date(START + PIN_LOCKOUT_MS).toISOString(),
  });
  expect(message).toContain("5 consecutive failed attempts");
}

// No gate may ever write a PIN value (or its hash) into any log line.
function expectNoPinInLogs() {
  const logged = JSON.stringify([
    ...vi.mocked(logger.warn).mock.calls,
    ...vi.mocked(logger.info).mock.calls,
    ...vi.mocked(logger.error).mock.calls,
  ]);
  expect(logged).not.toContain(CORRECT_PIN);
  expect(logged).not.toContain(WRONG_PIN);
  expect(logged).not.toContain(correctPinHash);
}

describe("PIN attempt lockout for transaction authorization", () => {
  it("rejects a wrong PIN with 401 and creates no transaction", async () => {
    const userId = freshUser({ pinHash: correctPinHash });

    const res = await sendEndpoint(userId, sendBody(WRONG_PIN));

    expect(res.status).toBe(401);
    expect(res.message).toBe("Incorrect PIN. Try again.");
    expect(res.transactionCreated).toBe(false);
    expect(users.get(userId)!.pinFailedAttempts).toBe(1);
  });

  it("locks out after 5 consecutive wrong PINs; the correct PIN is also rejected while locked", async () => {
    const userId = freshUser({ pinHash: correctPinHash });

    // Attempts 1-4: 401 with an identical, non-revealing message.
    for (let i = 1; i <= 4; i++) {
      const res = await sendEndpoint(userId, sendBody(WRONG_PIN));
      expect(res.status).toBe(401);
      expect(res.message).toBe("Incorrect PIN. Try again.");
      expect(res.transactionCreated).toBe(false);
    }
    expect(users.get(userId)!.pinFailedAttempts).toBe(4);

    // Attempt 5: lockout arms, counter resets to 0 for the post-lock window.
    const fifth = await sendEndpoint(userId, sendBody(WRONG_PIN));
    expect(fifth.status).toBe(423);
    expect(fifth.message).toBe("Too many incorrect PIN attempts. Try again in 15 minutes.");
    expect(fifth.transactionCreated).toBe(false);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
    expect(users.get(userId)!.pinLockedUntil).toBe(START + PIN_LOCKOUT_MS);

    // Security event: warn-level, transfer gate, correct fields, no PIN values.
    expectLockoutArmed("transfer", userId);
    expectNoPinInLogs();

    // While locked, even the CORRECT PIN is rejected — the window is absolute.
    const correctWhileLocked = await sendEndpoint(userId, sendBody(CORRECT_PIN));
    expect(correctWhileLocked.status).toBe(423);
    expect(correctWhileLocked.message).toContain("Too many incorrect PIN attempts");
    expect(correctWhileLocked.transactionCreated).toBe(false);

    // Cooldown attempts are visible too (info-level, not warnings).
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [cooldown] = vi.mocked(logger.info).mock.calls[0];
    expect(cooldown).toMatchObject({
      event: "pin_attempt_during_lockout",
      gate: "transfer",
      userId,
      lockedUntil: new Date(START + PIN_LOCKOUT_MS).toISOString(),
    });
    expect(logger.warn).toHaveBeenCalledTimes(1); // no second arming event
    expectNoPinInLogs();

    // And a wrong PIN during the lockout burns no extra attempt state.
    const wrongWhileLocked = await sendEndpoint(userId, sendBody(WRONG_PIN));
    expect(wrongWhileLocked.status).toBe(423);
    expect(users.get(userId)!.pinLockedUntil).toBe(START + PIN_LOCKOUT_MS);
  });

  it("allows the correct PIN again after the 15-minute cooldown expires", async () => {
    const userId = freshUser({ pinHash: correctPinHash });

    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await sendEndpoint(userId, sendBody(WRONG_PIN));
    }
    expect(users.get(userId)!.pinLockedUntil).not.toBeNull();
    expectLockoutArmed("transfer", userId);

    // Wrong attempts DURING the cooldown each log one lightweight line and
    // burn no attempt state, so a brute-forcer gains nothing but visibility.
    advanceMs(60_000);
    await sendEndpoint(userId, sendBody(WRONG_PIN));
    await sendEndpoint(userId, sendBody(WRONG_PIN));
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(users.get(userId)!.pinLockedUntil).toBe(START + PIN_LOCKOUT_MS);

    advanceMs(PIN_LOCKOUT_MS); // cooldown over

    const res = await sendEndpoint(userId, sendBody(CORRECT_PIN));
    expect(res.status).toBe(201);
    expect(res.transactionCreated).toBe(true);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
    expect(users.get(userId)!.pinLockedUntil).toBeNull();
    // Still exactly one arming event; retries in cooldown never re-arm.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expectNoPinInLogs();
  });

  it("resets the failed-attempt counter on successful PIN entry", async () => {
    const userId = freshUser({ pinHash: correctPinHash });

    for (let i = 0; i < 3; i++) {
      await sendEndpoint(userId, sendBody(WRONG_PIN));
    }
    expect(users.get(userId)!.pinFailedAttempts).toBe(3);

    const res = await sendEndpoint(userId, sendBody(CORRECT_PIN));
    expect(res.status).toBe(201);
    expect(res.transactionCreated).toBe(true);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
    expect(users.get(userId)!.pinLockedUntil).toBeNull();

    // Next wrong attempt counts from 1 again, not 4.
    await sendEndpoint(userId, sendBody(WRONG_PIN));
    expect(users.get(userId)!.pinFailedAttempts).toBe(1);
  });

  it("a missing PIN is rejected and creates no transaction", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    const res = await sendEndpoint(userId, sendBody());
    expect(res.status).toBe(400);
    expect(res.transactionCreated).toBe(false);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });

  it("a malformed PIN (not 6 digits) is a 400 and never counts as a failed attempt", async () => {
    const userId = freshUser({ pinHash: correctPinHash });
    const res = await sendEndpoint(userId, sendBody("12345"));
    expect(res.status).toBe(400);
    expect(res.transactionCreated).toBe(false);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });

  it("an account with no PIN set gets 409 and no lockout side effects", async () => {
    const userId = freshUser({ pinHash: null });
    const res = await sendEndpoint(userId, sendBody(CORRECT_PIN));
    expect(res.status).toBe(409);
    expect(res.transactionCreated).toBe(false);
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });
});

describe("pinLockoutService internals", () => {
  it("an expired lock re-baselines the counter instead of instantly re-locking", async () => {
    const userId = freshUser({ pinHash: correctPinHash, pinFailedAttempts: 4, pinLockedUntil: START - 1 });

    const attempts = await pinLockoutService.recordFailure(userId);
    expect(attempts).toBe(1);
    expect(users.get(userId)!.pinFailedAttempts).toBe(1);
    expect(users.get(userId)!.pinLockedUntil).toBeNull();
  });

  it("CAS retry keeps the count exact when two concurrent failures race", async () => {
    const userId = freshUser({ pinHash: correctPinHash });

    // Race simulation: this request reads the counter as 0, but a concurrent
    // request wins the row and bumps it to 1 before our write lands. The real
    // CAS (where pinFailedAttempts = 0) then fails against the row's new
    // value, and the retry records this attempt as the 2nd failure.
    db.user.findUnique.mockImplementationOnce(async () => {
      users.get(userId)!.pinFailedAttempts = 1; // the "other" request just won
      return { pinHash: correctPinHash, pinFailedAttempts: 0, pinLockedUntil: null }; // our stale read
    });

    const attempts = await pinLockoutService.recordFailure(userId);
    expect(attempts).toBe(2);
    expect(users.get(userId)!.pinFailedAttempts).toBe(2);
    db.user.findUnique.mockRestore();
  });

  it("getLockState reports unlocked once the window has expired", async () => {
    const userId = freshUser({ pinLockedUntil: START - 10 });
    const state = await pinLockoutService.getLockState(userId);
    expect(state).toEqual({ locked: false, until: null });
  });

  it("getLockState reports locked with the active window", async () => {
    const userId = freshUser({ pinLockedUntil: START + PIN_LOCKOUT_MS });
    const state = await pinLockoutService.getLockState(userId);
    expect(state.locked).toBe(true);
    expect(state.until).not.toBeNull();
  });
});
