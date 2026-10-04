import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

/**
 * The operational endpoints, driven through a real Fastify instance so the
 * status codes, auth gate and payload shapes are what a monitor would see.
 */
const state = vi.hoisted(() => ({
  dbOk: true,
  redisOk: true,
  dbError: "",
  // Migrations applied. 0 is the state that made the 2026-10-03 outage
  // invisible: the server was reachable, `SELECT 1` succeeded, and every real
  // query failed because the schema was gone.
  migrationCount: 9,
  queueCounts: {},
  isPaused: false,
  internalToken: undefined as string | undefined,
  nodeEnv: "test",
}));

vi.mock("../config/env.js", () => ({
  // Getters, not a snapshot: a test mutating `state` after the mock is
  // registered must be visible to the module under test.
  env: {
    get NODE_ENV() { return state.nodeEnv; },
    get INTERNAL_API_TOKEN() { return state.internalToken; },
    PORT: 4000,
    LOG_LEVEL: "info",
    QUEUE_DEPTH_LOG_INTERVAL_MS: 0,
    EMAIL_PROVIDER: "resend",
    EMAIL_FROM: "no-reply@ulmara.app",
    OTP_TTL_SECONDS: 600,
    RAMP_PROVIDER: "bitnob",
    SENTRY_ENVIRONMENT: undefined,
    ETHEREUM_CHAIN_ID: 11155111,
    BSC_CHAIN_ID: undefined,
    BASE_CHAIN_ID: undefined,
    POLYGON_CHAIN_ID: undefined,
  },
  assertEmailProviderConfigured: () => undefined,
  assertRampProviderConfigured: () => undefined,
}));

vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("../config/sentry.js", () => ({ isSentryEnabled: () => false, reportError: vi.fn() }));
vi.mock("../config/jwt.js", () => ({
  jwtRotationState: () => ({
    currentKeyConfigured: true,
    previousKeyConfigured: false,
    previousKeyActive: false,
    previousKeyRetiresAt: null,
    millisecondsUntilPreviousKeyRetires: null,
  }),
}));
vi.mock("../config/database.js", () => ({
  prisma: {
    // Answers both readiness queries. The tag is inspected because the two
    // calls mean different things: `SELECT 1` proves the socket works, while the
    // `_prisma_migrations` count proves the schema is actually deployed.
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (!state.dbOk) throw new Error(state.dbError || "db down");
      const sql = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (sql.includes("_prisma_migrations")) {
        if (state.migrationCount === -1) {
          throw new Error('relation "_prisma_migrations" does not exist');
        }
        return [{ finished: BigInt(state.migrationCount) }];
      }
      return [{ "?column?": 1 }];
    },
  },
}));
vi.mock("../queues/redis.client.js", () => ({
  getRedis: () => ({
    ping: async () => {
      if (!state.redisOk) throw new Error("redis down");
      return "PONG";
    },
  }),
}));
vi.mock("../services/email/index.js", () => ({
  isEmailProviderConfigured: () => false,
  getEmailProviderName: () => "resend",
}));
vi.mock("../services/ramp/providers/index.js", () => ({
  isRampProviderConfigured: () => false,
  getRampProviderName: () => "bitnob",
  validateNetworkConfiguration: () => [],
  RPC_ENV_VAR_BY_CHAIN: { ETH: "ETHEREUM_RPC_URL", BSC: "BSC_RPC_URL" },
  rpcConfiguredFor: () => true,
}));
// vi.fn wrappers so a test can make ONE queue's read fail.
vi.mock("../queues/transaction.queue.js", () => ({
  transactionQueue: {
    getJobCounts: vi.fn(async () => state.queueCounts),
    getDelayed: vi.fn(async () => []),
    isPaused: vi.fn(async () => state.isPaused),
  },
}));
vi.mock("../queues/ramp.queue.js", () => ({
  rampQueue: {
    getJobCounts: vi.fn(async () => state.queueCounts),
    getDelayed: vi.fn(async () => []),
    isPaused: vi.fn(async () => state.isPaused),
  },
}));

import { readQueueDepths, registerHealthRoutes } from "./health.routes.js";

async function app() {
  const instance = Fastify({ logger: false });
  registerHealthRoutes(instance);
  return instance;
}

beforeEach(() => {
  state.dbOk = true;
  state.redisOk = true;
  state.dbError = "";
  state.queueCounts = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  state.isPaused = false;
  state.internalToken = undefined;
  state.nodeEnv = "test";
});

describe("GET /health (liveness — what an uptime monitor polls)", () => {
  it("returns 200 with no auth and no dependency calls", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("stays 200 even when the database is down (liveness != readiness)", async () => {
    state.dbOk = false;
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("GET /health/ready (readiness)", () => {
  it("is 200 when both the database and Redis are reachable", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", checks: { database: { ok: true }, redis: { ok: true } } });
  });

  it("is 503 when the database is down", async () => {
    state.dbOk = false;
    state.dbError = "connection refused";
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("degraded");
    expect(res.json().checks.database.ok).toBe(false);
  });

  it("is 503 when Redis is down", async () => {
    state.redisOk = false;
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.redis.ok).toBe(false);
  });

  it("is 503 when the schema has NOT been deployed, even though SELECT 1 works", async () => {
    // THE regression from 2026-10-03. The database was reachable and answering
    // `SELECT 1`, so `checks.database.ok` was true and the endpoint returned 200
    // for seven hours while every Prisma-backed route returned 500 with
    // `relation "public.User" does not exist`. Readiness has to assert the schema
    // exists, not just that a socket does.
    state.migrationCount = -1; // _prisma_migrations absent
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe("degraded");
    // The connection itself was fine — that is precisely the trap.
    expect(res.json().checks.database.ok).toBe(true);
    expect(res.json().checks.schema.ok).toBe(false);
  });

  it("is 503 when migrations exist but none have finished", async () => {
    // A half-applied deploy: the table is there, the work is not done.
    state.migrationCount = 0;
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.schema.error).toMatch(/migrate deploy/);
  });

  it("reports schema ok once migrations have been applied", async () => {
    state.migrationCount = 9;
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().checks.schema).toEqual({ ok: true });
  });

  it("still answers /health 200 when the schema is missing (liveness != readiness)", async () => {
    // The liveness probe must stay cheap and dependency-free: a load balancer
    // restarting the process would not fix an un-deployed schema.
    state.migrationCount = -1;
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /internal/queues (BullMQ depth)", () => {
  it("reports per-queue depth for both queues", async () => {
    state.queueCounts = { waiting: 3, active: 1, delayed: 2, failed: 0, completed: 7 };
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/internal/queues" });
    expect(res.statusCode).toBe(200);
    const { queues } = res.json().data;
    expect(queues.map((q: { name: string }) => q.name).sort()).toEqual(["ramp", "transactions"]);
    const tx = queues.find((q: { name: string }) => q.name === "transactions");
    expect(tx).toMatchObject({ waiting: 3, active: 1, delayed: 2, failed: 0, completed: 7 });
  });

  it("surfaces a paused queue", async () => {
    state.isPaused = true;
    const depths = await readQueueDepths();
    expect(depths.every((d) => d.paused === 1)).toBe(true);
  });

  it("degrades one queue to -1 rather than failing the whole endpoint", async () => {
    const a = await app();
    // Break the underlying call for one queue only.
    const { transactionQueue } = await import("../queues/transaction.queue.js");
    vi.mocked(transactionQueue.getJobCounts).mockRejectedValueOnce(new Error("redis blip"));
    const res = await a.inject({ method: "GET", url: "/internal/queues" });
    expect(res.statusCode).toBe(200);
    const tx = res.json().data.queues.find((q: { name: string }) => q.name === "transactions");
    expect(tx.waiting).toBe(-1);
  });
});

describe("operational endpoint access control", () => {
  it("is open in a non-production environment when no token is set", async () => {
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/internal/queues" })).statusCode).toBe(200);
  });

  it("404s in production when no token is set, so detail is not exposed by default", async () => {
    state.nodeEnv = "production";
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/internal/queues" });
    expect(res.statusCode).toBe(404);
  });

  it("401s without a token once one is configured", async () => {
    state.internalToken = "s3cret-internal-token";
    const a = await app();
    expect((await a.inject({ method: "GET", url: "/internal/queues" })).statusCode).toBe(401);
  });

  it("accepts the correct bearer token", async () => {
    state.internalToken = "s3cret-internal-token";
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: "/internal/queues",
      headers: { authorization: "Bearer s3cret-internal-token" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong bearer token", async () => {
    state.internalToken = "s3cret-internal-token";
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: "/internal/queues",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /internal/config", () => {
  it("never returns a secret value", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/internal/config" });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    for (const forbidden of ["RESEND_API_KEY", "SENDGRID", "AWS_SES_SECRET", "BITNOB_CLIENT_SECRET", "JWT_SECRET", "TRIVERIFY", "DATABASE_URL", "REDIS_URL", "INTERNAL_API_TOKEN"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("reports the non-secret configuration an operator needs", async () => {
    const a = await app();
    const data = (await a.inject({ method: "GET", url: "/internal/config" })).json().data;
    expect(data).toMatchObject({
      nodeEnv: "test",
      email: { provider: "resend", configured: false, otpTtlSeconds: 600 },
      ramp: { provider: "bitnob", configured: false },
      monitoring: { sentry: false },
      chains: { ethereumChainId: 11155111 },
    });
    // JWT rotation state is reported WITHOUT any key material.
    expect(data.jwt).toMatchObject({ currentKeyConfigured: true, previousKeyActive: false });
  });
});
