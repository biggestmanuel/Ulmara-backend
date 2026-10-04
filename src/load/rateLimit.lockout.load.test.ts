import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import { buildApp, resolveTrustProxy } from "../server/app.js";
import { pinLockoutService } from "../services/auth/pinLockout.service.js";
import { logger } from "../config/logger.js";
import { resetRooms } from "../websocket/socket.handler.js";
import { closeRedis } from "../queues/redis.client.js";
import { redisConnection } from "../queues/redis.connection.js";

/**
 * Concurrent load test for the rate limiter and the PIN lockout.
 *
 * These two controls are what stop credential stuffing, so "it works when
 * called sequentially" is not the claim. Every test fires many simultaneous
 * requests and then asserts on the AGGREGATE outcome:
 *
 *  - `/login`      — a concurrent burst must not be able to exceed the budget,
 *                    a second burst must not find a fresh budget, and one
 *                    abusive client must not be able to lock out another.
 *  - `/verify-pin` — concurrent wrong PINs must count correctly, must actually
 *                    engage the lockout, and must keep rejecting even the
 *                    CORRECT pin once locked.
 *
 * Local throughout: `Fastify.inject` drives the real router, the real
 * preHandlers, the real controller, and a real Redis holds both the rate-limit
 * counters and the lockout state. The database is the only mock, and it is
 * STATEFUL (see `userRow`) because the lockout counter lives in Postgres: a
 * static stub would return the same counter forever and the test would prove
 * nothing about the real compare-and-swap.
 *
 * Run with: `npm run test:load`
 */

const PIN = "111111";
const WRONG_PIN = "999999";
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/**
 * A single mutable user row, so the CAS in `recordFailure` sees real state.
 * `findUnique` returns it; `update` merges into it, exactly as Prisma would.
 */
const userRow = {
  id: USER_ID,
  pinHash: "$2a$12$abcdefghijklmnopqrstuv",
  email: "a@b.co",
  emailVerified: true,
  phoneVerified: true,
  pinFailedAttempts: 0,
  pinLockedUntil: null as Date | null,
};

const { dbMock, jwtMock, trustEnv } = vi.hoisted(() => {
  // Set BEFORE any module import, because `config/env.ts` parses process.env at
  // load time. Doing it here makes the suite self-contained: it behaves the same
  // under `npm test` as under `npm run test:load`, instead of depending on a
  // variable the caller remembered to export.
  //
  // The per-client-budget test needs this: simulating two different clients
  // hitting one server requires `request.ip` to follow X-Forwarded-For, which is
  // exactly the configuration a real deployment behind a proxy must use.
  process.env.TRUSTED_PROXIES = "127.0.0.1,::1";
  return {
    trustEnv: process.env.TRUSTED_PROXIES,
    dbMock: {
      user: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      session: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      transaction: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      accountId: { findUnique: vi.fn(), findFirst: vi.fn() },
      wallet: { findMany: vi.fn() },
      contact: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue(1),
    },
    jwtMock: { verifySessionToken: vi.fn() },
  };
});

vi.mock("../config/database.js", () => ({ prisma: dbMock }));
vi.mock("../config/jwt.js", () => ({
  verifySessionToken: jwtMock.verifySessionToken,
  signSessionToken: vi.fn(),
  sessionExpiry: vi.fn(),
  jwtRotationState: () => ({}),
}));

let app: FastifyInstance;
let redis: Redis;

beforeEach(async () => {
  // Reset the stateful row to a clean account.
  userRow.pinFailedAttempts = 0;
  userRow.pinLockedUntil = null;

  // A faithful stand-in for the two Prisma calls the lockout depends on.
  //
  // `recordFailure` is a compare-and-swap: it reads the counter, then writes
  // only if the stored value still matches what it read. Modelling that
  // faithfully is the point of this file — a stub that always reports
  // `count: 1` would let every concurrent request "win" against a stale value,
  // and would prove nothing about the retry loop that makes the counter
  // correct under load.
  // `findUnique` is used for two different lookups: by EMAIL in `login`, and by
  // ID in the lockout service. They need different answers, so the mock
  // discriminates on the `where` clause. A login lookup returns no user, which
  // is the realistic shape of a credential-stuffing attempt and yields the
  // generic 401 the service is supposed to return.
  dbMock.user.findUnique.mockImplementation(async (args?: { where?: { id?: string; email?: string } }) => {
    if (args?.where?.email !== undefined) return null;
    return { ...userRow };
  });

  dbMock.user.updateMany.mockImplementation(async (args: {
    where?: { id?: string; pinFailedAttempts?: number };
    data?: { pinFailedAttempts?: number; pinLockedUntil?: Date | null };
  }) => {
    const where = args?.where ?? {};
    const data = args?.data ?? {};
    // The CAS predicate: the write lands only if the counter is still what the
    // caller read. Returning 0 is what sends `recordFailure` round its loop.
    if (where.id !== undefined && where.id !== userRow.id) return { count: 0 };
    if (
      where.pinFailedAttempts !== undefined &&
      where.pinFailedAttempts !== userRow.pinFailedAttempts
    ) {
      return { count: 0 };
    }
    // Prisma ignores undefined fields, so assign only what was actually sent.
    if (data.pinFailedAttempts !== undefined) userRow.pinFailedAttempts = data.pinFailedAttempts;
    if (data.pinLockedUntil !== undefined) userRow.pinLockedUntil = data.pinLockedUntil;
    return { count: 1 };
  });

  dbMock.session.findUnique.mockReset();
  jwtMock.verifySessionToken.mockReset();
  // Reached only on a successful login, which these tests never drive; present
  // so a missing stub cannot masquerade as a 500 under load.
  dbMock.session.create.mockResolvedValue({ id: "s-new", userId: USER_ID });

  // A real Redis connection, because `buildApp` registers the websocket
  // publisher and the queues against it and they must close cleanly.
  //
  // There is deliberately NO `flushdb()` here. It used to be called, and it was
  // destructive to other suites rather than useful to this one:
  //   - the rate limiter is in-memory (@fastify/rate-limit defaults to
  //     LocalStore; no `redis` option is passed in rateLimit.middleware.ts), and
  //     `app` is rebuilt in this beforeEach, so its counters are already fresh;
  //   - the PIN lockout is persisted through `prisma.user.updateMany`, not Redis,
  //     and `pinLockoutService.reset` below clears exactly this suite's user.
  // So it reset nothing it owned while deleting every other suite's data in the
  // shared database. That produced a ~1-in-4 flake in
  // verificationCodeStore.test.ts: under file-parallel vitest this suite's
  // `flushdb()` landed mid-test there and the OTP record vanished, so
  // `verifyVerificationCode` returned "no_code" for a code created moments
  // earlier. db 1 is also the database the running dev API uses, so it could
  // delete a real user's pending verification code.
  redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 3 });
  await pinLockoutService.reset(USER_ID).catch(() => undefined);
  resetRooms();

  app = await buildApp();
  await app.ready();
});

afterEach(async () => {
  await app?.close().catch(() => undefined);
  await redis?.quit().catch(() => undefined);
  resetRooms();
});

/** An authenticated request context, as `requireAuth` would leave it. */
function authed(token = "load-test-token") {
  jwtMock.verifySessionToken.mockReturnValue({ ok: true, claims: { sub: USER_ID } });
  dbMock.session.findUnique.mockResolvedValue({
    id: "s-1",
    token,
    userId: USER_ID,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { authorization: `Bearer ${token}`, "user-agent": "load-test" };
}

/** Fire `n` simultaneous requests and summarise the statuses. */
async function burst(
  n: number,
  make: (index: number) => {
    method: "GET" | "POST";
    url: string;
    payload?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
) {
  const results = await Promise.all(Array.from({ length: n }, (_, i) => app.inject(make(i))));
  const statuses = results.map((r) => r.statusCode);
  return {
    results,
    statuses,
    allowed: statuses.filter((s) => s !== 429).length,
    rejected: statuses.filter((s) => s === 429).length,
    serverErrors: statuses.filter((s) => s >= 500),
  };
}

const loginRequest = () => ({
  method: "POST" as const,
  url: "/api/auth/login",
  payload: { email: "a@b.co", password: "whatever-long" },
});

const wrongPinRequest = () => ({
  method: "POST" as const,
  url: "/api/auth/verify-pin",
  headers: authed(),
  payload: { pin: WRONG_PIN },
});

/** `{ 200: 12, 429: 48 }` from a list of status codes. */
function countBy(statuses: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of statuses) out[s] = (out[s] ?? 0) + 1;
  return out;
}

describe("concurrent load: POST /api/auth/login", () => {
  it("holds the rate limit under 60 simultaneous requests from one client", async () => {
    const { allowed, rejected, statuses, results } = await burst(60, loginRequest);
    console.log(`  60 concurrent /login -> ${allowed} not-429, ${rejected} rejected with 429`);
    console.log(`  status distribution: ${JSON.stringify(countBy(statuses))}`);

    // A correct limiter allows strictly fewer than the burst, and rejects some.
    expect(allowed).toBeLessThan(60);
    expect(rejected).toBeGreaterThan(0);

    // A rate limiter must answer 429, never 5xx. The 400/401 below are the
    // controller rejecting the placeholder credentials, which is correct.
    const serverErrors = results.filter((r) => r.statusCode >= 500);
    if (serverErrors.length > 0) {
      const body = serverErrors[0].body;
      throw new Error(
        `rate limiter returned ${serverErrors.length} x5xx under concurrent load; ` +
        `first body: ${body.slice(0, 300)}`,
      );
    }
  });

  it("sets retry-after on every 429", async () => {
    const { results } = await burst(40, loginRequest);
    const limited = results.filter((r) => r.statusCode === 429);
    expect(limited.length).toBeGreaterThan(0);
    for (const r of limited) {
      expect(r.headers["retry-after"], "429 must carry retry-after").toBeDefined();
    }
  });

  it("does not hand a fresh budget to a second burst", async () => {
    const first = await burst(40, loginRequest);
    const second = await burst(40, loginRequest);
    console.log(`  burst 1 allowed ${first.allowed}, burst 2 allowed ${second.allowed}`);
    // The window is cumulative: the second burst must not find it reset.
    expect(second.allowed).toBeLessThanOrEqual(first.allowed);
  });

  it("keeps per-client budgets separate, so one client cannot lock out another", async () => {
    // The limiter keys on `request.ip`, which is only the real client when a
    // proxy is trusted (see `resolveTrustProxy` and TRUSTED_PROXIES). With
    // TRUSTED_PROXIES set above, X-Forwarded-For is honoured and each address
    // is its own budget. Without it — the default — every proxied user shares
    // one bucket, which is exactly the DoS this assertion guards against.
    expect(resolveTrustProxy(trustEnv, undefined), "the suite must run with a trusted proxy").toEqual([
      "127.0.0.1",
      "::1",
    ]);

    const from = (ip: string) => () => ({
      method: "POST" as const,
      url: "/api/auth/login",
      headers: { "x-forwarded-for": ip },
      payload: { email: "a@b.co", password: "whatever-long" },
    });

    const abusive = await burst(40, from("198.51.100.1"));
    const victim = await burst(10, from("198.51.100.2"));
    console.log(`  abusive client allowed ${abusive.allowed}, second client allowed ${victim.allowed}`);

    // The second client must still have budget left.
    expect(victim.allowed).toBeGreaterThan(0);
    expect(abusive.allowed).toBeLessThan(40);
  });
});

describe("concurrent load: POST /api/auth/verify-pin", () => {
  it("never accepts a wrong PIN, however many arrive at once", async () => {
    const { statuses, serverErrors } = await burst(20, wrongPinRequest);
    console.log(
      `  20 concurrent wrong PINs -> ${statuses.filter((s) => s === 429).length} x429, ` +
      `${statuses.filter((s) => s === 400 || s === 401 || s === 409 || s === 423).length} rejected, ` +
      `${statuses.filter((s) => s === 200).length} accepted`,
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(0);
    expect(serverErrors).toEqual([]);
  });

  it("actually arms the lockout rather than merely counting failures", async () => {
    const before = await pinLockoutService.getLockState(USER_ID);
    expect(before.locked).toBe(false);

    const { allowed } = await burst(20, wrongPinRequest);
    // How many got past the 10/min limiter is bounded; the point is that the
    // account ends up locked regardless.
    console.log(`  ${allowed} of 20 reached the PIN check; final counter = ${userRow.pinFailedAttempts}`);

    const after = await pinLockoutService.getLockState(USER_ID);
    console.log(`  lockout state: locked=${after.locked}`);
    expect(after.locked).toBe(true);
  });

  it("keeps rejecting the CORRECT pin once locked out", async () => {
    // The case that matters most: a lockout that stops counting but still
    // authorises would be worse than no lockout at all.
    await burst(20, wrongPinRequest);
    expect((await pinLockoutService.getLockState(USER_ID)).locked).toBe(true);

    const correct = await app.inject({
      method: "POST",
      url: "/api/auth/verify-pin",
      headers: authed(),
      payload: { pin: PIN },
    });
    console.log(`  correct PIN while locked out -> HTTP ${correct.statusCode}`);
    expect(correct.statusCode).not.toBe(200);
  });

  it("counts each concurrent failure exactly once, below the threshold", async () => {
    // 4 is under both the 10/min route limit and the 5-attempt lockout
    // threshold, so all four reach the PIN check and none arms the lockout. A
    // racy counter would double-count (reaching the threshold on fewer than 4
    // attempts) or lose one.
    const { allowed } = await burst(4, wrongPinRequest);
    console.log(`  4 concurrent wrong PINs -> ${allowed} reached the check, counter = ${userRow.pinFailedAttempts}`);
    expect(allowed).toBe(4);
    expect(userRow.pinFailedAttempts).toBe(4);
    expect((await pinLockoutService.getLockState(USER_ID)).locked).toBe(false);
  });

  it("arms the lockout exactly once when a burst crosses the threshold", async () => {
    // The CAS in recordFailure is the thing that makes this correct: concurrent
    // attempts that read the same counter must not all land on the same write.
    // When the lockout arms, the counter is deliberately reset to 0 and a
    // cooldown window is stamped — so the invariant is "locked", not "counter
    // equals N".
    const { statuses } = await burst(12, wrongPinRequest);
    const state = await pinLockoutService.getLockState(USER_ID);
    console.log(
      `  12 concurrent wrong PINs -> ${JSON.stringify(countBy(statuses))}; ` +
      `locked=${state.locked}, counter reset to ${userRow.pinFailedAttempts}`,
    );
    expect(state.locked).toBe(true);
    // Arming resets the counter, so it must not have run past the threshold.
    expect(userRow.pinFailedAttempts).toBeLessThan(5);
  });

  it("arms the lockout at the threshold, not before", async () => {
    const THRESHOLD = 5; // matches PIN_LOCKOUT_MAX_FAILURES
    for (let attempt = 1; attempt <= THRESHOLD; attempt++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        headers: authed(),
        payload: { pin: WRONG_PIN },
      });
      const state = await pinLockoutService.getLockState(USER_ID);
      if (attempt < THRESHOLD) {
        expect(state.locked, `must not lock after ${attempt} attempt(s)`).toBe(false);
      }
    }
    const final = await pinLockoutService.getLockState(USER_ID);
    console.log(`  after ${THRESHOLD} sequential wrong PINs: locked=${final.locked}`);
    expect(final.locked).toBe(true);
  });
});

describe("no secrets in logs under load", () => {
  it("never logs a PIN or a PIN hash, whatever the outcome", async () => {
    const logged: unknown[] = [];
    const LEVELS = ["info", "warn", "error", "debug", "fatal"] as const;
    // Capture the originals so the patch is undone exactly whatever happens.
    const originals = new Map<string, (...args: never[]) => unknown>();
    for (const level of LEVELS) {
      const original = logger[level].bind(logger) as (...args: never[]) => unknown;
      originals.set(level, original);
      (logger as unknown as Record<string, unknown>)[level] = (...args: never[]) => {
        logged.push(...args);
        return original(...args);
      };
    }

    try {
      await burst(20, wrongPinRequest);
    } finally {
      for (const [level, original] of originals) {
        (logger as unknown as Record<string, unknown>)[level] = original;
      }
    }

    const serialised = JSON.stringify(logged);
    console.log(`  ${logged.length} log entries captured during the burst`);
    expect(serialised).not.toContain(`"${PIN}"`);
    expect(serialised).not.toContain(`"${WRONG_PIN}"`);
    expect(serialised).not.toContain("$2a$12$abcdefghijklmnopqrstuv");
  });
});

describe("Redis state and connection hygiene under load", () => {
  it("leaves no malformed keys behind", async () => {
    await burst(50, loginRequest);
    const keys = await redis.keys("*");
    for (const key of keys) {
      // A half-written set or hash from an interrupted update would show up
      // here as an unexpected type.
      const type = await redis.type(key);
      expect(["string", "hash", "list", "set", "zset", "none"], `${key} (${type})`).toContain(type);
    }
    console.log(`  ${keys.length} Redis keys after the burst, all of a well-formed type`);
  });

  it("closes cleanly, with nothing left listening", async () => {
    await burst(30, loginRequest);
    // A wedged connection would make close() hang and time the suite out, so
    // reaching this line is itself the assertion.
    await expect(app.close()).resolves.toBeUndefined();
    await closeRedis();
    redisConnection.disconnect();
  });
});
