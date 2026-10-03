import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Endpoint-level input validation, exercised through the real controllers.
 *
 * The audit of `src/routes/` found that request BODIES were validated nearly
 * everywhere while path/query values were read through bare casts with no
 * runtime effect. `src/utils/requestSchemas.test.ts` covers the schemas
 * themselves; this file covers the two things only a controller-level test can
 * show:
 *
 *  1. a malformed value is a **400 through the standard error envelope**, not a
 *     crash, a 500, or a value that reaches Prisma;
 *  2. a validation failure happens **before** any service call, so a bad id
 *     cannot become a database query.
 */

const { prismaMock, walletServiceMock, transactionServiceMock, authServiceMock, contactServiceMock, rampServiceMock, paymentServiceMock, accountServiceMock } =
  vi.hoisted(() => ({
    prismaMock: {
      user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
      wallet: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
      transaction: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
      contact: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn() },
      accountId: { findUnique: vi.fn(), findFirst: vi.fn() },
      rampTransaction: { findFirst: vi.fn() },
      paymentRequest: { findUnique: vi.fn() },
      $queryRaw: vi.fn(),
    },
    walletServiceMock: { getBalances: vi.fn(), getAddresses: vi.fn(), resolveAccountId: vi.fn(), registerWallets: vi.fn(), listSupportedTokens: vi.fn() },
    transactionServiceMock: { list: vi.fn(), getById: vi.fn(), getStatus: vi.fn(), broadcast: vi.fn(), estimateFee: vi.fn(), send: vi.fn() },
    authServiceMock: { verifyEmail: vi.fn(), verifyPhone: vi.fn(), resendVerificationCode: vi.fn(), revokeSession: vi.fn(), listSessions: vi.fn() },
    contactServiceMock: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
    rampServiceMock: { getStatus: vi.fn() },
    paymentServiceMock: { getRequest: vi.fn(), fulfillRequest: vi.fn(), createRequest: vi.fn() },
    accountServiceMock: { getByAccountId: vi.fn(), resolveForTransfer: vi.fn(), updateSettings: vi.fn() },
  }));

vi.mock("../config/database.js", () => ({ prisma: prismaMock }));
vi.mock("../services/wallet/wallet.service.js", () => ({ walletService: walletServiceMock }));
vi.mock("../services/transaction/transaction.service.js", () => ({ transactionService: transactionServiceMock }));
vi.mock("../services/auth/auth.service.js", () => ({ authService: authServiceMock }));
vi.mock("../services/contact.service.js", () => ({ contactService: contactServiceMock }));
vi.mock("../services/ramp/ramp.service.js", () => ({ rampService: rampServiceMock }));
vi.mock("../services/payment/payment.service.js", () => ({ paymentService: paymentServiceMock }));
vi.mock("../services/account/account.service.js", () => ({ accountService: accountServiceMock }));
vi.mock("../config/env.js", () => ({ env: { RAMP_PROVIDER: "bitnob" } }));

import { accountController } from "./account.controller.js";
import { authController } from "./auth.controller.js";
import { contactController } from "./contact.controller.js";
import { paymentController } from "./payment.controller.js";
import { transactionController } from "./transaction.controller.js";
import { walletController } from "./wallet.controller.js";

/** Minimal FastifyReply double that records the status code actually sent. */
function reply() {
  const state: { status: number; payload?: unknown } = { status: 200 };
  const r = {
    code(n: number) { state.status = n; return r; },
    header() { return r; },
    send(payload?: unknown) { state.payload = payload; return r; },
    state,
  };
  return r;
}

const req = (over: Record<string, unknown> = {}) => ({ userId: "u-1", headers: {}, ip: "127.0.0.1", ...over }) as never;

/** Runs a controller and reports the status it replied with. */
async function call(fn: (rq: never, rp: never) => Promise<unknown>, request: unknown) {
  const r = reply();
  await fn(request as never, r as never);
  return r.state;
}

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID2 = "9c858901-8a57-4791-81fe-4c455b099bc9";

beforeEach(() => {
  // These mocks are nested two levels deep (model -> operation), so walk the
  // whole tree rather than only the top level.
  const reset = (node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === "function" && "mockReset" in value) {
        (value as { mockReset: () => void }).mockReset();
      } else if (typeof value === "object" && value !== null) {
        reset(value);
      }
    }
  };
  for (const m of [
    prismaMock, walletServiceMock, transactionServiceMock, authServiceMock,
    contactServiceMock, rampServiceMock, paymentServiceMock, accountServiceMock,
  ]) {
    reset(m);
  }
});

describe("GET /wallet/resolve/:accountId", () => {
  it("rejects a non-10-digit account id with 400 and never calls the service", async () => {
    for (const bad of ["123", "12345678901", "abcdefghij", "123456789a"]) {
      const state = await call(walletController.resolveAccountId, req({ params: { accountId: bad } }));
      expect(state.status, bad).toBe(400);
      expect(walletServiceMock.resolveAccountId).not.toHaveBeenCalled();
    }
  });

  it("passes a valid account id through", async () => {
    walletServiceMock.resolveAccountId.mockResolvedValue({ ok: true });
    const state = await call(walletController.resolveAccountId, req({ params: { accountId: "1234567890" } }));
    expect(state.status).toBe(200);
    expect(walletServiceMock.resolveAccountId).toHaveBeenCalledWith("1234567890");
  });
});

describe("GET /wallet/tokens/:chain", () => {
  it("rejects an unknown or lowercase chain with 400", async () => {
    for (const bad of ["DOGE", "eth", "", "ETH;DROP"]) {
      const state = await call(walletController.listTokens, req({ params: { chain: bad } }));
      expect(state.status, bad).toBe(400);
      expect(walletServiceMock.listSupportedTokens).not.toHaveBeenCalled();
    }
  });

  it("accepts every supported chain", async () => {
    walletServiceMock.listSupportedTokens.mockResolvedValue([]);
    for (const chain of ["ETH", "BTC", "BSC", "BASE", "POLYGON", "TRON", "SOL", "TON"]) {
      const state = await call(walletController.listTokens, req({ params: { chain } }));
      expect(state.status, chain).toBe(200);
    }
  });
});

describe("POST /wallet/register", () => {
  it("rejects a missing addresses array with 400", async () => {
    const state = await call(walletController.registerWallets, req({ body: {} }));
    expect(state.status).toBe(400);
    expect(walletServiceMock.registerWallets).not.toHaveBeenCalled();
  });

  it("rejects an oversized batch that would drive unbounded on-chain calls", async () => {
    const addresses = Array.from({ length: 21 }, () => ({ chain: "ETH", address: "0xabc" }));
    const state = await call(walletController.registerWallets, req({ body: { addresses } }));
    expect(state.status).toBe(400);
    expect(walletServiceMock.registerWallets).not.toHaveBeenCalled();
  });

  it("rejects an unknown key rather than silently ignoring it", async () => {
    const state = await call(walletController.registerWallets, req({
      body: { addresses: [{ chain: "ETH", address: "0xabc" }], overwrite: true },
    }));
    expect(state.status).toBe(400);
    expect(walletServiceMock.registerWallets).not.toHaveBeenCalled();
  });

  it("accepts a valid batch", async () => {
    walletServiceMock.registerWallets.mockResolvedValue({ registered: 1 });
    const state = await call(walletController.registerWallets, req({
      body: { addresses: [{ chain: "ETH", address: "0xabc" }] },
    }));
    expect(state.status).toBe(200);
    expect(walletServiceMock.registerWallets).toHaveBeenCalledWith("u-1", [{ chain: "ETH", address: "0xabc" }]);
  });
});

describe("GET /transaction (pagination)", () => {
  it("rejects a limit above 100, which would ask for the whole table", async () => {
    const state = await call(transactionController.list, req({ query: { limit: "100000" } }));
    expect(state.status).toBe(400);
    expect(transactionServiceMock.list).not.toHaveBeenCalled();
  });

  it("rejects page=0 and non-numeric values", async () => {
    for (const bad of ["0", "-1", "abc", "1e3"]) {
      const state = await call(transactionController.list, req({ query: { page: bad } }));
      expect(state.status, bad).toBe(400);
    }
    expect(transactionServiceMock.list).not.toHaveBeenCalled();
  });

  it("defaults to page 1 limit 20 when no query is supplied", async () => {
    transactionServiceMock.list.mockResolvedValue({ items: [] });
    const state = await call(transactionController.list, req({ query: {} }));
    expect(state.status).toBe(200);
    expect(transactionServiceMock.list).toHaveBeenCalledWith("u-1", 1, 20);
  });
});

describe("GET /transaction/:id", () => {
  it("rejects a non-UUID id with 400 and never queries the database", async () => {
    for (const bad of ["not-a-uuid", "1", ""]) {
      const state = await call(transactionController.getById, req({ params: { id: bad } }));
      expect(state.status, bad).toBe(400);
    }
    expect(transactionServiceMock.getById).not.toHaveBeenCalled();
    expect(prismaMock.transaction.findUnique).not.toHaveBeenCalled();
  });

  it("accepts a UUID", async () => {
    transactionServiceMock.getById.mockResolvedValue({ id: UUID });
    const state = await call(transactionController.getById, req({ params: { id: UUID } }));
    expect(state.status).toBe(200);
  });
});

describe("POST /transaction/:id/broadcast", () => {
  it("rejects a malformed id before looking at the body", async () => {
    const state = await call(transactionController.broadcast, req({
      params: { id: "nope" },
      body: { signedTx: "0x" + "ab".repeat(100) },
    }));
    expect(state.status).toBe(400);
    expect(transactionServiceMock.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a too-short signed transaction", async () => {
    const state = await call(transactionController.broadcast, req({
      params: { id: UUID },
      body: { signedTx: "0x123" },
    }));
    expect(state.status).toBe(400);
    expect(transactionServiceMock.broadcast).not.toHaveBeenCalled();
  });

  it("accepts a valid id and payload", async () => {
    transactionServiceMock.broadcast.mockResolvedValue({ txHash: "0xabc" });
    const state = await call(transactionController.broadcast, req({
      params: { id: UUID },
      body: { signedTx: "0x" + "ab".repeat(100) },
    }));
    expect(state.status).toBe(200);
    expect(transactionServiceMock.broadcast).toHaveBeenCalledWith("u-1", UUID, expect.any(String));
  });
});

describe("verification endpoints take identity from the session, not the body", () => {
  it("verify-email ignores a body-supplied userId and uses the session", async () => {
    authServiceMock.verifyEmail.mockResolvedValue({ id: "u-1" });
    // A caller must not be able to verify an arbitrary account: the schema no
    // longer accepts a userId, so the session is the only source of identity.
    const state = await call(authController.verifyEmail, req({
      body: { code: "123456", userId: UUID2 },
    }));
    expect(state.status).toBe(400);
    expect(authServiceMock.verifyEmail).not.toHaveBeenCalled();
  });

  it("verify-email uses the session's userId when the body is valid", async () => {
    authServiceMock.verifyEmail.mockResolvedValue({ id: "u-1" });
    const state = await call(authController.verifyEmail, req({ body: { code: "123456" } }));
    expect(state.status).toBe(200);
    expect(authServiceMock.verifyEmail).toHaveBeenCalledWith({ code: "123456", userId: "u-1" });
  });

  it("resend-code likewise uses the session's userId", async () => {
    authServiceMock.resendVerificationCode.mockResolvedValue({ sent: true });
    const state = await call(authController.resendCode, req({ body: { channel: "email" } }));
    expect(state.status).toBe(200);
    expect(authServiceMock.resendVerificationCode).toHaveBeenCalledWith("u-1", "email");
  });

  it("rejects a body userId on resend-code", async () => {
    const state = await call(authController.resendCode, req({ body: { channel: "email", userId: UUID2 } }));
    expect(state.status).toBe(400);
    expect(authServiceMock.resendVerificationCode).not.toHaveBeenCalled();
  });
});

describe("DELETE /contacts/:id", () => {
  it("rejects a non-UUID contact id with 400", async () => {
    for (const bad of ["1", "not-a-uuid", ""]) {
      const state = await call(contactController.remove, req({ params: { id: bad } }));
      expect(state.status, bad).toBe(400);
    }
    expect(contactServiceMock.remove).not.toHaveBeenCalled();
    expect(prismaMock.contact.deleteMany).not.toHaveBeenCalled();
  });

  it("accepts a UUID", async () => {
    contactServiceMock.remove.mockResolvedValue({ deleted: true });
    const state = await call(contactController.remove, req({ params: { id: UUID } }));
    expect(state.status).toBe(200);
    expect(contactServiceMock.remove).toHaveBeenCalledWith("u-1", UUID);
  });
});

describe("public account lookup", () => {
  it("still validates the account id even though the route is unauthenticated", async () => {
    const state = await call(accountController.getByAccountId, req({ userId: undefined, params: { accountId: "12" } }));
    expect(state.status).toBe(400);
    expect(accountServiceMock.getByAccountId).not.toHaveBeenCalled();
  });
});

describe("payment request", () => {
  it("rejects a malformed transactionId on fulfill", async () => {
    const state = await call(paymentController.fulfillRequest, req({
      params: { id: UUID },
      body: { transactionId: "not-a-uuid" },
    }));
    expect(state.status).toBe(400);
    expect(paymentServiceMock.fulfillRequest).not.toHaveBeenCalled();
  });

  it("rejects an amount with too many decimals before the service is called", async () => {
    // 19 decimal places cannot round-trip through Decimal(36, 18), and
    // toBaseUnits would throw on it, so it must be a 400 at the edge.
    paymentServiceMock.createRequest.mockResolvedValue({ id: UUID });
    const state = await call(paymentController.createRequest, req({
      body: { asset: "USDC", amount: "1.0000000000000000001" },
    }));
    expect(state.status).toBe(400);
    expect(paymentServiceMock.createRequest).not.toHaveBeenCalled();
  });

  it("rejects a zero amount", async () => {
    const state = await call(paymentController.createRequest, req({
      body: { asset: "USDC", amount: "0.00" },
    }));
    expect(state.status).toBe(400);
    expect(paymentServiceMock.createRequest).not.toHaveBeenCalled();
  });

  it("accepts a valid amount", async () => {
    paymentServiceMock.createRequest.mockResolvedValue({ id: UUID });
    const state = await call(paymentController.createRequest, req({
      body: { asset: "USDC", amount: "1.5" },
    }));
    expect(state.status).toBe(201); // created
    expect(paymentServiceMock.createRequest).toHaveBeenCalledWith("u-1", expect.objectContaining({ amount: "1.5" }));
  });
});
