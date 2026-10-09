import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// `POST /api/transaction/send` must answer with the same shape as `GET
// /api/transaction/:id` and `GET /api/transaction`.
//
// Found by a frontend contract audit. The create path returned the bare Prisma
// row while both read paths added two derived fields:
//
//   POST /api/transaction/send  ->  no direction, no counterpartyAccountId
//   GET  /api/transaction/:id   ->  direction, counterpartyAccountId
//   GET  /api/transaction       ->  direction, counterpartyAccountId
//
// The client filled the gap with `?? 'sent'` in `normalizeTransaction`, which
// produced the right answer — a row this endpoint returns is by definition
// outgoing from the caller — but only by luck. A fallback that is correct today
// for the wrong reason is exactly what keeps working after the reason stops
// being true.
//
// Every assertion here is on the RESPONSE SHAPE. Asserting only the status
// would pass against the old implementation, which is the whole point.
// ---------------------------------------------------------------------------

const SENDER = "user-sender";
const RECIPIENT_ACCOUNT_ID = "9259531853";

const { db } = vi.hoisted(() => ({
  db: {
    accountId: {
      findUnique: vi.fn(async ({ where }: { where: { accountId?: string; userId?: string } }) => {
        if (where.accountId) {
          return where.accountId === "9259531853"
            ? { accountId: "9259531853", userId: "user-recipient" }
            : null;
        }
        return { accountId: "1111111111", userId: where.userId };
      }),
    },
    wallet: {
      findUnique: vi.fn(async () => ({ address: "0x1111111111111111111111111111111111111111" })),
    },
    transaction: {
      // findByIdempotencyKey uses findUnique; getById/list use findFirst/findMany.
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "tx-created",
        senderId: SENDER,
        // Echo what was asked for. A mock that hardcoded the recipient would make
        // the external-transfer case untestable: it would always look internal.
        recipientAccountId: (data.recipientAccountId ?? null) as string | null,
        recipientAddress: (data.recipientAddress ?? null) as string | null,
        asset: "ETH",
        amount: "0.001",
        network: "ETH",
        feeAmount: null,
        status: "PENDING",
        txHash: null,
        idempotencyKey: data.idempotencyKey,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    session: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    $queryRaw: vi.fn(async () => []),
  },
}));

vi.mock("../../config/database.js", () => ({ prisma: db }));
vi.mock("../../queues/transaction.queue.js", () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock("../../blockchain/triverify.js", () => ({ verifyAddressExists: vi.fn(async () => undefined) }));
vi.mock("../auth/pinLockout.service.js", () => ({
  pinLockoutService: { assertPinAuthorized: vi.fn(async () => undefined) },
}));
vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

const { transactionService } = await import("./transaction.service.js");

const INPUT = {
  senderId: SENDER,
  recipientAccountId: RECIPIENT_ACCOUNT_ID,
  asset: "ETH",
  amount: "0.001",
  network: "ETH" as const,
  pin: "123456",
  idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
});

describe("the create path answers with the fields the read paths send", () => {
  it("a fresh create carries direction and counterpartyAccountId", async () => {
    const tx = await transactionService.send(INPUT);

    expect(tx).toHaveProperty("direction", "sent");
    expect(tx).toHaveProperty("counterpartyAccountId", RECIPIENT_ACCOUNT_ID);
  });

  // An external transfer has no Account ID, only a raw address. getById and list
  // both fall back to the address, so create must too — otherwise the same
  // transaction would describe its counterparty differently depending on which
  // endpoint answered.
  it("an external transfer falls back to the raw address as the counterparty", async () => {
    const tx = await transactionService.send({
      ...INPUT,
      recipientAccountId: undefined,
      recipientAddress: "0x3333333333333333333333333333333333333333",
    });

    expect(tx.direction).toBe("sent");
    expect(tx.counterpartyAccountId).toBe("0x3333333333333333333333333333333333333333");
  });

  // A replay is a return point of this same function. If the replay answered
  // with the bare row, an idempotent retry would change the response contract
  // under the caller — the caller would see `direction` disappear on a retry.
  it("a replayed idempotency key answers with the SAME shape as the create", async () => {
    const stored = {
      id: "tx-stored",
      senderId: SENDER,
      recipientAccountId: RECIPIENT_ACCOUNT_ID,
      recipientAddress: "0x1111111111111111111111111111111111111111",
      asset: "ETH",
      amount: "0.001",
      network: "ETH",
      feeAmount: null,
      status: "PENDING",
      txHash: null,
      idempotencyKey: INPUT.idempotencyKey,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    db.transaction.findUnique.mockResolvedValueOnce(stored as never);

    const replay = await transactionService.send(INPUT);

    expect(replay).toHaveProperty("direction", "sent");
    expect(replay).toHaveProperty("counterpartyAccountId", RECIPIENT_ACCOUNT_ID);
  });

  it("the row itself is not mutated — the fields are added, not moved", async () => {
    const tx = await transactionService.send(INPUT);
    // Everything the client already relied on must still be there.
    expect(tx.id).toBe("tx-created");
    expect(tx.status).toBe("PENDING");
    expect(tx.recipientAccountId).toBe(RECIPIENT_ACCOUNT_ID);
    expect(tx.recipientAddress).toBe("0x1111111111111111111111111111111111111111");
    expect(tx.asset).toBe("ETH");
    expect(tx.amount).toBe("0.001");
    expect(tx.network).toBe("ETH");
    expect(tx).toHaveProperty("senderId", SENDER);
  });

  // The point of the change: the three endpoints that return a transaction now
  // agree. Before, create was the odd one out and the client compensated.
  it("create and getById expose the same two derived fields", async () => {
    const created = await transactionService.send(INPUT);
    expect(Object.keys(created).sort()).toEqual(
      expect.arrayContaining(["direction", "counterpartyAccountId"]),
    );

    db.transaction.findFirst.mockResolvedValueOnce({
      id: "tx-created",
      senderId: SENDER,
      recipientAccountId: RECIPIENT_ACCOUNT_ID,
      recipientAddress: "0x1111111111111111111111111111111111111111",
      asset: "ETH",
      amount: "0.001",
      network: "ETH",
      feeAmount: null,
      status: "PENDING",
      txHash: null,
      idempotencyKey: INPUT.idempotencyKey,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      sender: { accountId: { accountId: "2222222222" } },
    } as never);

    const fetched = await transactionService.getById(SENDER, "tx-created");
    expect(fetched).toHaveProperty("direction");
    expect(fetched).toHaveProperty("counterpartyAccountId");
  });
});
