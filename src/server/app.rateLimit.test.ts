import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The real app runs here (real global limiter + real per-route limiters);
// controllers and auth are stubbed to pure 200 handlers so the tests exercise
// ONLY rate-limiting behavior, and the usual env/logger/DB/Redis mocks keep
// buildApp hermetic.
// ---------------------------------------------------------------------------

const envState = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test" as string,
    ALLOWED_ORIGINS: "http://localhost:8081,http://localhost:19006",
  },
}));

vi.mock("../config/env.js", () => ({ env: envState.env }));

vi.mock("../config/logger.js", () => {
  const logger: Record<string, unknown> = {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => logger),
  };
  return { logger };
});

vi.mock("../config/database.js", () => ({
  prisma: {},
  connectDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
}));

vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("../queues/transaction.queue.js", () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock("../queues/ramp.queue.js", () => ({ rampQueue: { add: vi.fn() } }));
vi.mock("../jobs/transaction.worker.js", () => ({}));
vi.mock("../jobs/ramp.worker.js", () => ({}));

// Stubbed auth: "Bearer <name>" maps to userId "user-<name>", so the per-user
// limiter keying can be tested without JWT/session machinery.
vi.mock("../middleware/auth.middleware.js", () => ({
  requireAuth: async (request: { headers: Record<string, string | undefined>; userId?: string }) => {
    const header = request.headers.authorization;
    request.userId = header?.startsWith("Bearer ") ? `user-${header.slice(7)}` : undefined;
  },
}));

// Every controller method becomes the same success handler; rate-limit tests
// only care about the status the limiter produces, not handler output.
const okHandler = async (_request: unknown, reply: { code: (c: number) => { send: (b: unknown) => unknown } }) =>
  reply.code(200).send({ success: true });

vi.mock("../controllers/auth.controller.js", () => ({
  authController: new Proxy({}, { get: () => okHandler }),
}));
vi.mock("../controllers/transaction.controller.js", () => ({
  transactionController: new Proxy({}, { get: () => okHandler }),
}));
vi.mock("../controllers/externalTransfer.controller.js", () => ({
  externalTransferController: new Proxy({}, { get: () => okHandler }),
}));

import { buildApp } from "./app.js";

const RATE_LIMIT_MESSAGE = "Too many requests. Please slow down and try again later.";

async function build() {
  const app = await buildApp();
  return app;
}

describe("per-route rate limits", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  afterEach(async () => {
    await app?.close();
  });

  it("throttles /api/auth/login per IP: 11th request from one IP gets 429 before the global limit", async () => {
    app = await build();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
      expect(res.statusCode).toBe(200);
    }

    const eleventh = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers["retry-after"]).toBeDefined();
  });

  it("isolates login budgets per IP", async () => {
    app = await build();

    for (let i = 0; i < 10; i++) {
      await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    }
    const sameIp = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(sameIp.statusCode).toBe(429);

    const otherIp = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {},
      remoteAddress: "10.9.9.9",
    });
    expect(otherIp.statusCode).toBe(200);
  });

  it("throttles /api/auth/verify-pin per user and never keys one user's usage to another", async () => {
    app = await build();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        payload: {},
        headers: { authorization: "Bearer alice" },
      });
      expect(res.statusCode).toBe(200);
    }
    const aliceBlocked = await app.inject({
      method: "POST",
      url: "/api/auth/verify-pin",
      payload: {},
      headers: { authorization: "Bearer alice" },
    });
    expect(aliceBlocked.statusCode).toBe(429);

    // Different user, same IP: separate budget.
    const bob = await app.inject({
      method: "POST",
      url: "/api/auth/verify-pin",
      payload: {},
      headers: { authorization: "Bearer bob" },
    });
    expect(bob.statusCode).toBe(200);
  });

  it("gives /api/transaction/send its own budget, separate from the other transfer routes", async () => {
    app = await build();

    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/transaction/send",
        payload: {},
        headers: { authorization: "Bearer alice" },
      });
      expect(res.statusCode).toBe(200);
    }
    const sendBlocked = await app.inject({
      method: "POST",
      url: "/api/transaction/send",
      payload: {},
      headers: { authorization: "Bearer alice" },
    });
    expect(sendBlocked.statusCode).toBe(429);

    // The external-transfer routes have their own budgets.
    const prepare = await app.inject({
      method: "POST",
      url: "/api/transaction/external/prepare",
      payload: {},
      headers: { authorization: "Bearer alice" },
    });
    expect(prepare.statusCode).toBe(200);

    const submit = await app.inject({
      method: "POST",
      url: "/api/transaction/external/intent-1/submit",
      payload: {},
      headers: { authorization: "Bearer alice" },
    });
    expect(submit.statusCode).toBe(200);
  });

  it("external prepare and submit each hit their own 429 at the 11th request", async () => {
    app = await build();

    for (let i = 0; i < 10; i++) {
      const prepare = await app.inject({
        method: "POST",
        url: "/api/transaction/external/prepare",
        payload: {},
        headers: { authorization: "Bearer alice" },
      });
      expect(prepare.statusCode).toBe(200);

      const submit = await app.inject({
        method: "POST",
        url: "/api/transaction/external/intent-1/submit",
        payload: {},
        headers: { authorization: "Bearer alice" },
      });
      expect(submit.statusCode).toBe(200);
    }

    const prepareBlocked = await app.inject({
      method: "POST",
      url: "/api/transaction/external/prepare",
      payload: {},
      headers: { authorization: "Bearer alice" },
    });
    expect(prepareBlocked.statusCode).toBe(429);

    const submitBlocked = await app.inject({
      method: "POST",
      url: "/api/transaction/external/intent-1/submit",
      payload: {},
      headers: { authorization: "Bearer alice" },
    });
    expect(submitBlocked.statusCode).toBe(429);
  });

  it("returns the standard non-revealing 429 envelope", async () => {
    app = await build();

    for (let i = 0; i <= 10; i++) {
      await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    }

    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();

    const body = res.json();
    expect(body).toEqual({ success: false, message: RATE_LIMIT_MESSAGE });
    // Nothing about the account, user, or remaining attempts leaks.
    expect(JSON.stringify(body)).not.toMatch(/user|id|attempt|pin/i);
  });

  it("does not interfere with the PIN lockout budget: 5 attempts (lockout threshold) stay allowed", async () => {
    app = await build();

    // A lockout arms on the 5th consecutive wrong PIN — well inside the
    // 10-request per-route budget, so the throttle can never prevent the
    // lockout from arming.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/verify-pin",
        payload: {},
        headers: { authorization: "Bearer alice" },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("keeps the global 100/min limiter intact on everything else", async () => {
    app = await build();

    for (let i = 0; i < 100; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }

    const exceeded = await app.inject({ method: "GET", url: "/health" });
    expect(exceeded.statusCode).toBe(429);
    // Global limiter keeps its own (default) message — per-route limits did
    // not replace it.
    expect(String(exceeded.json().message)).toMatch(/Rate limit exceeded/);
  });
});
