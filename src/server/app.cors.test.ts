import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The real app (and therefore the real @fastify/cors plugin) runs here; only
// env, the logger, and the modules that would open DB/Redis connections at
// import time are mocked, so buildApp stays hermetic in CI.
// ---------------------------------------------------------------------------

const envState = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test",
    ALLOWED_ORIGINS: "http://localhost:8081,http://localhost:19006",
  },
}));

// The app calls the fail-loud env assertions at build time. These tests are
// about CORS only, so the assertions are stubbed to no-ops.
vi.mock("../config/env.js", () => ({
  env: envState.env,
  assertEmailProviderConfigured: () => undefined,
  assertRampProviderConfigured: () => undefined,
}));

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

import { buildApp, parseAllowedOrigins } from "./app.js";

describe("parseAllowedOrigins", () => {
  const originalNodeEnv = envState.env.NODE_ENV;

  afterEach(() => {
    envState.env.NODE_ENV = originalNodeEnv;
  });

  it("trims entries, drops empties, and dedupes", () => {
    expect(
      parseAllowedOrigins(" http://localhost:8081 , http://localhost:19006 ,, http://localhost:8081 "),
    ).toEqual(["http://localhost:8081", "http://localhost:19006"]);
  });

  it("throws when nothing usable is configured", () => {
    expect(() => parseAllowedOrigins("")).toThrow(/at least one origin/);
    expect(() => parseAllowedOrigins("  ,  ")).toThrow(/at least one origin/);
  });

  it("rejects non-https origins in production", () => {
    envState.env.NODE_ENV = "production";
    expect(() => parseAllowedOrigins("https://app.example.com,http://localhost:8081")).toThrow(
      /https:\/\/ origins in production/,
    );
  });

  it("accepts an all-https list in production", () => {
    envState.env.NODE_ENV = "production";
    expect(parseAllowedOrigins("https://app.example.com,https://admin.example.com")).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
  });
});

describe("CORS allowlist", () => {
  const ALLOWED = "http://localhost:8081";
  const DISALLOWED = "https://evil.example";

  beforeEach(() => {
    envState.env.NODE_ENV = "test";
    envState.env.ALLOWED_ORIGINS = `${ALLOWED},http://localhost:19006`;
  });

  it("returns CORS headers for an allowlisted origin (frontend dev flow)", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: ALLOWED } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
    // Non-static origin option must always set Vary for caches.
    expect(String(res.headers.vary)).toContain("Origin");

    await app.close();
  });

  it("withholds CORS headers from a disallowed origin (browser blocks the response)", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: DISALLOWED } });

    // The request itself completes (CORS is a browser-enforced policy), but
    // without Access-Control-Allow-Origin the browser refuses the response.
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("sends no CORS headers for Origin-less requests (native/mobile clients)", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("approves preflights only for allowlisted origins", async () => {
    const app = await buildApp();

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/login",
      headers: { origin: ALLOWED, "access-control-request-method": "POST" },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(ALLOWED);
    expect(String(allowed.headers["access-control-allow-methods"])).toContain("POST");

    const disallowed = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/login",
      headers: { origin: DISALLOWED, "access-control-request-method": "POST" },
    });
    expect(disallowed.statusCode).toBe(204);
    expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });
});
