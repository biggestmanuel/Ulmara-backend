import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B2: an empty body with `Content-Type: application/json` is no body.
//
// The real app runs (real router, real content-type parser); only env, logger
// and connection-opening modules are mocked, so `Fastify.inject` drives the same
// code path a request takes in production.
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

describe("B2: an empty JSON body is no body", () => {
  beforeEach(() => {
    envState.env.NODE_ENV = "test";
    envState.env.ALLOWED_ORIGINS = `${ALLOWED},http://localhost:19006`;
  });

  // requireAuth rejects before the handler, which is what proves the request
  // reached the ROUTE rather than being refused by the parser as it would be
  // without the fix. 401 (not 400) is therefore the pass condition.
  it("POST /api/account/create-account-id with Content-Type and no body is not a 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/create-account-id",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).not.toBe(400);
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("DELETE /api/auth/me with Content-Type and no body is not a 400", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/me",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).not.toBe(400);
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("treats a whitespace-only body as no body too", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/account/create-account-id",
      headers: { "content-type": "application/json" },
      payload: "   ",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  // The fix must not make a bodyless POST to a route that REQUIRES fields pass.
  it("a route that genuinely requires a body still 400s when it is missing", async () => {
    const app = await buildApp();
    // /api/auth/login requires email + password and is unauthenticated, so this
    // exercises the schema path with no token in the way.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ success: boolean; message: string }>();
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/email|password|input/i);
    await app.close();
  });

  it("a route that requires a body still 400s on missing required fields", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "a@b.test" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toMatch(/password/i);
    await app.close();
  });

  it("malformed JSON is still a 400, not a 500 and not silently accepted", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("a real body on a bodyless route is parsed, not dropped", async () => {
    const app = await buildApp();
    // create-account-id ignores its body, so the observable proof that parsing
    // still happens is that a malformed body is rejected rather than swallowed.
    const res = await app.inject({
      method: "POST",
      url: "/api/account/create-account-id",
      headers: { "content-type": "application/json" },
      payload: "{oops",
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
