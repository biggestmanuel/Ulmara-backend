import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B4/C4: CORS must advertise PATCH, or the new contact-rename route is
// unreachable from a browser — the preflight is rejected before the request
// leaves the page. The real app runs (real @fastify/cors); only env, logger and
// connection-opening modules are mocked.
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

describe("B4/C4: CORS advertises PATCH", () => {
  beforeEach(() => {
    envState.env.NODE_ENV = "test";
    envState.env.ALLOWED_ORIGINS = `${ALLOWED},http://localhost:19006`;
  });

  it("answers a preflight for PATCH /api/contact/:id with PATCH allowed", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/contact/00000000-0000-4000-8000-000000000000",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    const methods = String(res.headers["access-control-allow-methods"]);
    for (const m of ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]) {
      expect(methods).toContain(m);
    }
    await app.close();
  });

  it.each(["GET", "POST", "PATCH", "DELETE"])(
    "a preflight asking for %s is allowed from an allowlisted origin",
    async (method) => {
      const app = await buildApp();
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api/contact/00000000-0000-4000-8000-000000000000",
        headers: { origin: ALLOWED, "access-control-request-method": method },
      });
      expect(String(res.headers["access-control-allow-methods"])).toContain(method);
      await app.close();
    },
  );

  it("does not hand CORS headers to a disallowed origin", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/contact/00000000-0000-4000-8000-000000000000",
      headers: { origin: "https://evil.example", "access-control-request-method": "PATCH" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});
