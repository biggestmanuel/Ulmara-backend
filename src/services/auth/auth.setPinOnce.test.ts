import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// `POST /api/auth/set-pin` must set a PIN ONCE, never overwrite one.
//
// The endpoint used to hash the supplied PIN and write it unconditionally, with
// no check for an existing PIN and no current-PIN proof. `changePin` already
// did this correctly (requires the current PIN, rate limited to 5/min, attempts
// counted toward the shared lockout), which made `setPin` an unauthenticated-by-
// knowledge way around it: anyone holding only a session token could replace the
// victim's PIN and then pass the transfer gate with a value they had chosen.
//
// Proven live before the fix, on a throwaway account:
//
//   POST /set-pin {pin:"111111"}  -> 200
//   POST /set-pin {pin:"999999"}  -> 200   <- overwrote, no 409, no proof
//   verify-pin "111111"           -> 401 Incorrect PIN. Try again.
//   verify-pin "999999"           -> 200
//   send with pin "999999"        -> 201 PENDING      <- funds moved
//   9 rapid set-pin calls         -> 200 x9          <- not rate limited
//
// The load-bearing assertion in every test below is that the ORIGINAL hash
// survives a refused overwrite. Asserting only the status code would still pass
// against an implementation that returned 409 *after* writing.
// ---------------------------------------------------------------------------

const USER = "user-1";
const GENUINE = "111111";
const ATTACKER = "999999";

const { users, db } = vi.hoisted(() => {
  const users = new Map<string, { pinHash: string | null; pinFailedAttempts: number; pinLockedUntil: Date | null }>();
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        return row ? { ...row } : null;
      }),
      // The conditional-claim write. `pinHash: null` in the `where` is the
      // atomicity guarantee setPin relies on; a plain update would ignore it.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; pinHash?: string | null };
          data: { pinHash?: string; pinFailedAttempts?: number; pinLockedUntil?: Date | null };
        }) => {
          const row = users.get(where.id);
          if (!row) return { count: 0 };
          if (where.pinHash !== undefined && row.pinHash !== where.pinHash) return { count: 0 };
          if (data.pinHash !== undefined) row.pinHash = data.pinHash;
          if (data.pinFailedAttempts !== undefined) row.pinFailedAttempts = data.pinFailedAttempts;
          if (data.pinLockedUntil !== undefined) row.pinLockedUntil = data.pinLockedUntil;
          return { count: 1 };
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { pinHash: string } }) => {
        const row = users.get(where.id);
        if (row) row.pinHash = data.pinHash;
        return row ?? {};
      }),
    },
  };
  return { users, db };
});

vi.mock("../../config/database.js", () => ({ prisma: db }));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock("../../config/env.js", () => ({
  env: { DEV_VERIFICATION_MODE: false, NODE_ENV: "test", OTP_TTL_SECONDS: 600, OTP_EXPIRY_GRACE_SECONDS: 60 },
  isProd: false,
}));

const { authService } = await import("./auth.service.js");

/** The hash currently stored, so a test can prove it did or did not change. */
const stored = () => users.get(USER)?.pinHash ?? null;

beforeEach(() => {
  users.clear();
  vi.clearAllMocks();
  users.set(USER, { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null });
});

describe("authService.setPin", () => {
  it("sets a PIN when the account has none", async () => {
    await expect(authService.setPin(USER, GENUINE)).resolves.toEqual({ success: true });
    expect(stored()).not.toBeNull();
    await expect(bcrypt.compare(GENUINE, stored()!)).resolves.toBe(true);
  });

  it("refuses to overwrite an existing PIN with a 409", async () => {
    await authService.setPin(USER, GENUINE);

    await expect(authService.setPin(USER, ATTACKER)).rejects.toMatchObject({
      statusCode: 409,
      message: "A PIN is already set for this account",
    });
  });

  it("leaves the ORIGINAL hash intact after a refused overwrite", async () => {
    // The load-bearing assertion. A 409 returned *after* writing would satisfy
    // the status check above while still handing over the account.
    await authService.setPin(USER, GENUINE);
    const before = stored();

    await expect(authService.setPin(USER, ATTACKER)).rejects.toThrow();

    expect(stored()).toBe(before);
    await expect(bcrypt.compare(GENUINE, stored()!)).resolves.toBe(true);
    await expect(bcrypt.compare(ATTACKER, stored()!)).resolves.toBe(false);
  });

  it("cannot be replayed to walk the PIN forward over many calls", async () => {
    await authService.setPin(USER, GENUINE);
    const before = stored();

    // The old endpoint answered 200 to every one of these.
    for (const candidate of ["222222", "333333", ATTACKER, "000000", "121212"]) {
      await expect(authService.setPin(USER, candidate)).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(stored()).toBe(before);
  });

  it("grants exactly one winner when two first-time calls race", async () => {
    // The write is a claim (`pinHash: null` in the where), not a plain update,
    // so this holds under concurrency rather than only in sequence.
    const results = await Promise.allSettled([
      authService.setPin(USER, GENUINE),
      authService.setPin(USER, ATTACKER),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ statusCode: 409 });

    // Whichever won, the stored hash must verify against exactly one of them.
    const isGenuine = await bcrypt.compare(GENUINE, stored()!);
    const isAttacker = await bcrypt.compare(ATTACKER, stored()!);
    expect([isGenuine, isAttacker].filter(Boolean)).toHaveLength(1);
  });

  it("404s for an account that does not exist", async () => {
    await expect(authService.setPin("no-such-user", GENUINE)).rejects.toMatchObject({
      statusCode: 404,
      message: "Account not found",
    });
  });

  it("still refuses a PIN that is not 6 digits", async () => {
    for (const bad of ["12345", "1234567", "abcdef", ""]) {
      await expect(authService.setPin(USER, bad)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(stored()).toBeNull();
  });

  it("does not hash at all when the account already has a PIN", async () => {
    // bcrypt at 12 rounds is the expensive part; a refused call must not pay it.
    await authService.setPin(USER, GENUINE);
    const hash = vi.spyOn(bcrypt, "hash");

    await expect(authService.setPin(USER, ATTACKER)).rejects.toThrow();
    expect(hash).not.toHaveBeenCalled();
  });

  it("still allows a first PIN after a refused attempt on a fresh account", async () => {
    // 400s must leave the account able to set a PIN — the guard must not wedge it.
    await expect(authService.setPin(USER, "nope")).rejects.toMatchObject({ statusCode: 400 });
    await expect(authService.setPin(USER, GENUINE)).resolves.toEqual({ success: true });
  });
});

describe("setPin vs changePin no longer overlap", () => {
  it("setPin is first-time only; changePin owns replacement", async () => {
    await authService.setPin(USER, GENUINE);

    // setPin refuses the replacement...
    await expect(authService.setPin(USER, ATTACKER)).rejects.toMatchObject({ statusCode: 409 });
    // ...so the only route to a new PIN is changePin, which demands the current one.
    await expect(authService.changePin(USER, ATTACKER, "222222")).rejects.toMatchObject({ statusCode: 401 });
    await expect(authService.changePin(USER, GENUINE, "222222")).resolves.toEqual({ success: true });
    await expect(bcrypt.compare("222222", stored()!)).resolves.toBe(true);
  });
});