import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B3/C3: the payment-request `note`, and the public pay-link shape.
//
// Two distinct defects:
//   1. `note` did not exist, so a payment request carried no context at all.
//   2. `GET /api/payment/request/:id` is UNAUTHENTICATED (it is shared by link
//      and QR) and returned the raw Prisma row, which carries `userId` — the
//      internal user id — on a public endpoint. The response is now built
//      explicitly instead.
//
// The real app, the real zod schema and the real service run. Only env, logger,
// prisma and the auth middleware are stubbed.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  row: null as Record<string, unknown> | null,
}));

vi.mock("../config/env.js", () => ({
  env: { NODE_ENV: "test", ALLOWED_ORIGINS: "http://localhost:8081" },
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
  prisma: {
    paymentRequest: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.created.push(args.data);
        return { id: "req-1", ...args.data };
      }),
      findUnique: vi.fn(async () => state.row),
    },
    accountId: {
      findUnique: vi.fn(async () => ({ accountId: "1234567890" })),
    },
  },
  connectDatabase: vi.fn(),
  disconnectDatabase: vi.fn(),
}));

vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("../queues/transaction.queue.js", () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock("../queues/ramp.queue.js", () => ({ rampQueue: { add: vi.fn() } }));
vi.mock("../jobs/transaction.worker.js", () => ({}));
vi.mock("../jobs/ramp.worker.js", () => ({}));

// Authenticated for the create route; the public GET is left unauthenticated on
// purpose, because that is the property under test.
vi.mock("../middleware/auth.middleware.js", () => ({
  requireAuth: async (request: { userId?: string }) => {
    request.userId = "user-1";
  },
}));

import { buildApp } from "./app.js";

const UUID = "3f1b0c9e-7a1d-4a2b-9c3d-5e6f70819aa2";

const create = async (body: unknown) => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/api/payment/request",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  await app.close();
  return res;
};

beforeEach(() => {
  state.created = [];
  state.row = null;
});

describe("B3: note is optional, trimmed, capped at 140, and empty means absent", () => {
  it("stores a note", async () => {
    const res = await create({ asset: "USDC", amount: "10.50", note: "Invoice 42" });
    expect(res.statusCode).toBe(201);
    expect(state.created[0].note).toBe("Invoice 42");
  });

  it("trims the note before storing it", async () => {
    await create({ asset: "USDC", note: "   Invoice 42   " });
    expect(state.created[0].note).toBe("Invoice 42");
  });

  it("treats an empty string as absent (null in the column)", async () => {
    await create({ asset: "USDC", note: "" });
    expect(state.created[0].note).toBeNull();
  });

  it("treats a whitespace-only note as absent", async () => {
    await create({ asset: "USDC", note: "   \t  " });
    expect(state.created[0].note).toBeNull();
  });

  it("accepts a note of exactly 140 characters", async () => {
    const note = "x".repeat(140);
    const res = await create({ asset: "USDC", note });
    expect(res.statusCode).toBe(201);
    expect(state.created[0].note).toBe(note);
  });

  it("rejects a note of 141 characters", async () => {
    const res = await create({ asset: "USDC", note: "x".repeat(141) });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/140/);
    expect(state.created).toHaveLength(0);
  });

  it("measures the cap on the TRIMMED value, not the padded input", async () => {
    // 140 real characters plus surrounding whitespace is still 140 stored.
    const res = await create({ asset: "USDC", note: `   ${"x".repeat(140)}   ` });
    expect(res.statusCode).toBe(201);
    expect(String(state.created[0].note)).toHaveLength(140);
  });

  it("remains optional", async () => {
    const res = await create({ asset: "USDC" });
    expect(res.statusCode).toBe(201);
    expect(state.created[0].note).toBeNull();
  });

  it("still requires asset or symbol", async () => {
    const res = await create({ note: "no asset" });
    expect(res.statusCode).toBe(400);
  });

  it("still rejects unknown fields — the schema stays strict", async () => {
    const res = await create({ asset: "USDC", note: "hi", userId: "someone-else" });
    expect(res.statusCode).toBe(400);
    expect(state.created).toHaveLength(0);
  });
});

describe("B3: the public pay-link response", () => {
  const publicGet = async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: `/api/payment/request/${UUID}` });
    await app.close();
    return res;
  };

  beforeEach(() => {
    state.row = {
      id: UUID,
      userId: "internal-user-id-0000",
      asset: "USDC",
      // A Prisma Decimal, not a number: the wire value must stay exact.
      amount: { toString: () => "10.50" },
      note: "Invoice 42",
      status: "OPEN",
      expiresAt: null,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      fulfilledTransactionId: null,
      fulfilledAt: null,
      user: { name: "Ada" },
    };
  });

  it("adds note, symbol, requesterAccountId and requesterName", async () => {
    const res = await publicGet();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      note: "Invoice 42",
      symbol: "USDC",
      requesterAccountId: "1234567890",
      requesterName: "Ada",
    });
  });

  it("keeps every field it already returned", async () => {
    const res = await publicGet();
    const data = res.json().data;
    for (const key of ["id", "status", "amount", "asset", "expiresAt", "createdAt"]) {
      expect(data).toHaveProperty(key);
    }
    expect(data.amount).toBe("10.50");
  });

  it("never exposes the internal user id, an email, or a phone number", async () => {
    const res = await publicGet();
    const raw = res.body;
    expect(raw).not.toContain("internal-user-id-0000");
    expect(raw).not.toMatch(/userId/i);
    expect(raw).not.toMatch(/email/i);
    expect(raw).not.toMatch(/phone/i);
    expect(Object.keys(res.json().data)).not.toContain("userId");
  });

  it("returns a null note for a request created before the migration", async () => {
    state.row!.note = null;
    const res = await publicGet();
    expect(res.json().data.note).toBeNull();
  });

  it("returns a null requesterName when the owner has no name", async () => {
    state.row!.user = { name: null };
    const res = await publicGet();
    expect(res.json().data.requesterName).toBeNull();
  });

  it("needs no authentication at all", async () => {
    // No token is sent. This is deliberate (shared by link/QR) and is exactly
    // why the response is built field-by-field rather than returned raw.
    const res = await publicGet();
    expect(res.statusCode).toBe(200);
  });

  it("404s for an unknown request id", async () => {
    state.row = null;
    const res = await publicGet();
    expect(res.statusCode).toBe(404);
  });
});