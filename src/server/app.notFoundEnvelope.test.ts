import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// A router 404 must use the same `{ success: false, message }` envelope as every
// other error.
//
// Fastify's router rejects an unmatched path itself, so a 404 never reaches
// `setErrorHandler` and used to come back as
//   { message: "Route GET:/x not found", error: "Not Found", statusCode: 404 }
// with no `success` key. The client only surfaces a server message when the body
// is exactly `{ success: false, message }`, so the one 404 a caller most wants to
// read was the one whose message got thrown away.
//
// Same shape as the other app-level tests: the real app and the real router,
// with only env/logger/connection-opening modules mocked, so `Fastify.inject`
// drives the same path a live request takes.
// ---------------------------------------------------------------------------

const envState = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test",
    ALLOWED_ORIGINS: "http://localhost:8081,http://localhost:19006",
  },
}));

vi.mock("../config/env.js", () => ({
  env: envState.env,
  assertEmailProviderConfigured: () => undefined,
  assertRampProviderConfigured: () => undefined,
}));

vi.mock("../config/logger.js", () => {
  const logger: Record<string, unknown> = {
    fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn(() => logger),
  };
  return { logger };
});

vi.mock("../config/database.js", () => ({
  prisma: {}, connectDatabase: vi.fn(), disconnectDatabase: vi.fn(),
}));
vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("../queues/transaction.queue.js", () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock("../queues/ramp.queue.js", () => ({ rampQueue: { add: vi.fn() } }));
vi.mock("../jobs/transaction.worker.js", () => ({}));
vi.mock("../jobs/ramp.worker.js", () => ({}));

import { buildApp } from "./app.js";

const ALLOWED = "http://localhost:8081";

describe("a router 404 uses the standard error envelope", () => {
  beforeEach(() => {
    envState.env.NODE_ENV = "test";
    envState.env.ALLOWED_ORIGINS = `${ALLOWED},http://localhost:19006`;
  });

  it("an unknown path answers 404 with success:false and a message", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ success: boolean; message: string }>();
    expect(body.success).toBe(false);
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);
    await app.close();
  });

  // This is the case worth naming: the path is real, the verb is wrong. The
  // route table is published at /docs/json, so saying so is not a disclosure.
  it("the wrong method on a real route still answers 404 in the envelope", async () => {
    const app = await buildApp();
    // /api/auth/login exists, but only as POST. A GET must not fall through to
    // a handler, and must not answer in Fastify's default shape.
    const res = await app.inject({ method: "GET", url: "/api/auth/login" });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ success: boolean; message: string }>();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/not found/i);
    await app.close();
  });

  it("the message names the method and the path that missed", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "DELETE", url: "/api/nope/nope" });

    expect(res.statusCode).toBe(404);
    const body = res.json<{ message: string }>();
    expect(body.message).toContain("DELETE");
    expect(body.message).toContain("/api/nope/nope");
    await app.close();
  });

  // The point of the fix: one shape for every error, so a client can parse one
  // thing. A 404 raised by a service already went through the error handler, so
  // a router 404 must be indistinguishable in shape from anything else the error
  // handler produces.
  //
  // The comparison uses a 400 rather than a service 404 on purpose: this suite
  // mocks `prisma` as `{}`, so any handler that touches the database throws and
  // answers 500. A validation failure needs no database and still comes from the
  // same `errorResponse` call the not-found handler uses.
  it("a router 404 has the same body shape as any other error", async () => {
    const app = await buildApp();

    const routerMiss = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    // /api/auth/login is unauthenticated, so a bad body reaches the schema and
    // is answered by the error handler rather than refused with a 401.
    const handlerError = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: 123 }),
    });

    expect(routerMiss.statusCode).toBe(404);
    expect(handlerError.statusCode).toBe(400);
    // Identical key sets: the router 404 is not a special shape any more.
    expect(Object.keys(routerMiss.json<Record<string, unknown>>()).sort()).toEqual(
      Object.keys(handlerError.json<Record<string, unknown>>()).sort(),
    );
    await app.close();
  });

  // A guard against the fix leaking: the 404 must not be a 200, must not be a
  // 500, and must not turn a route that DOES exist into a miss.
  it("a real route is still not turned into a 404", async () => {
    const app = await buildApp();
    // 401, not 404: the route exists and only the credentials are missing.
    const res = await app.inject({ method: "GET", url: "/api/account/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("the health route is unaffected", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Misses are rate limited, because the global limiter cannot reach them.
//
// @fastify/rate-limit installs its `onRequest` hook from inside `onRoute`, so the
// hook exists only on registered routes. An unmatched path has no route, so it had
// no counter: measured on the live server before this, 130 requests to a real
// endpoint produced 30 x 429 and 130 requests to unknown paths produced 0. The
// documented per-IP ceiling did not apply to the traffic an attacker would send.
// ---------------------------------------------------------------------------
describe("unrouted paths are rate limited", () => {
  beforeEach(() => {
    envState.env.NODE_ENV = "test";
    envState.env.ALLOWED_ORIGINS = `${ALLOWED},http://localhost:19006`;
  });

  it("throttles misses once the budget is spent, and answers 429 in the envelope", async () => {
    const app = await buildApp();
    const MISS_LIMIT = 60;

    // Under the budget: every one is a real 404 with a real message.
    for (let i = 0; i < MISS_LIMIT; i++) {
      const res = await app.inject({ method: "GET", url: `/api/unrouted-${i}` });
      expect(res.statusCode, `request ${i} should be a 404`).toBe(404);
    }

    // Over it: 429, in the same shape as every other error, with retry-after.
    const throttled = await app.inject({ method: "GET", url: "/api/unrouted-over" });
    expect(throttled.statusCode).toBe(429);
    const body = throttled.json<{ success: boolean; message: string }>();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/too many requests/i);
    expect(throttled.headers["retry-after"]).toBeDefined();

    await app.close();
  });

  // The miss budget must be its own counter. If it shared the global store, a
  // client that made a few typos would throttle its own real traffic.
  it("miss-counting does not throttle a real route", async () => {
    const app = await buildApp();
    // Burn the whole miss budget on unrouted paths.
    for (let i = 0; i < 60; i++) {
      await app.inject({ method: "GET", url: `/api/typo-${i}` });
    }
    // A real route is still served normally.
    const res = await app.inject({ method: "GET", url: "/api/account/me" });
    expect(res.statusCode).toBe(401); // reached the route; only auth is missing
    await app.close();
  });

  it("an ordinary typo still gets the helpful 404, not a 429", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/acount/me" });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ message: string }>().message).toContain("/api/acount/me");
    await app.close();
  });
});
