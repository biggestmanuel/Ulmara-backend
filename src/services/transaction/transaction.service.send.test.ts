import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The real transactionService.send/broadcast run here. Mocked: prisma
// (in-memory maps with unique-constraint enforcement on the idempotency key),
// the chain adapter, TriVerify, the PIN lockout (covered by its own suite),
// and the BullMQ queue. prisma.$transaction runs its callback against a tx
// client sharing the same maps, so the duplicate re-check observes exactly
// what a serialized Postgres transaction would.
// ---------------------------------------------------------------------------

const { accounts, wallets, transactions } = vi.hoisted(() => ({
  accounts: new Map<string, { userId: string; accountId: string }>(),
  wallets: new Map<string, { userId: string; chain: string; address: string }>(),
  transactions: new Map<string, Record<string, unknown>>(),
}));

const SENDER = "sender-1";
const RECIPIENT_ACCOUNT_ID = "1234567890";
const RECIPIENT_ADDRESS = "0x" + "ab".repeat(20);

vi.mock("../../config/database.js", () => {
  const findByKey = (key?: string) => {
    if (key === undefined) return null;
    for (const row of transactions.values()) {
      if (row.idempotencyKey === key) return { ...row };
    }
    return null;
  };

  const transactionClient = {
    transaction: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.idempotencyKey !== undefined) return findByKey(where.idempotencyKey);
        const row = where.id ? transactions.get(where.id) : undefined;
        return row ? { ...row } : null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.idempotencyKey === "string") {
          for (const row of transactions.values()) {
            if (row.idempotencyKey === data.idempotencyKey) {
              // Postgres unique violation, Prisma code P2002.
              throw Object.assign(new Error("Unique constraint failed on the fields: (`idempotencyKey`)"), {
                code: "P2002",
              });
            }
          }
        }
        const row = { id: `tx-${transactions.size + 1}`, status: "PENDING", ...data };
        transactions.set(row.id, row);
        return { ...row };
      }),
    },
    // Stand-in for SELECT ... FOR UPDATE on the sender's wallet row.
    $queryRaw: vi.fn(async () => []),
  };

  return {
    prisma: {
      accountId: {
        findUnique: vi.fn(async ({ where }: { where: { accountId: string } }) => {
          const row = accounts.get(where.accountId);
          return row ? { ...row } : null;
        }),
      },
      wallet: {
        findUnique: vi.fn(async ({ where }: { where: { userId_chain: { userId: string; chain: string } } }) => {
          for (const row of wallets.values()) {
            if (row.userId === where.userId_chain.userId && row.chain === where.userId_chain.chain) {
              return { ...row };
            }
          }
          return null;
        }),
      },
      transaction: {
        ...transactionClient.transaction,
        findFirst: vi.fn(async ({ where }: { where: { id: string; OR: Record<string, unknown>[] } }) => {
          const row = transactions.get(where.id);
          // getById's ownership filter: sender or (recipient via account).
          if (!row) return null;
          const isSender = row.senderId === SENDER;
          const isRecipient = where.OR?.some((clause) => clause.recipientAccountId === RECIPIENT_ACCOUNT_ID);
          if (!isSender && !isRecipient) return null;
          return { ...row, sender: { accountId: null } };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; senderId?: string; status?: string; txHash?: null }; data: Record<string, unknown> }) => {
          const row = transactions.get(where.id);
          if (!row) return { count: 0 };
          if (where.senderId !== undefined && row.senderId !== where.senderId) return { count: 0 };
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      // Serialized interactive transaction: the callback sees the same maps,
      // which is all the duplicate re-check needs in a single-threaded test.
      $transaction: vi.fn(async (fn: (tx: typeof transactionClient) => Promise<unknown>) => fn(transactionClient)),
    },
  };
});

vi.mock("../../chains/index.js", () => ({
  getChainAdapter: vi.fn(async () => ({
    chain: "ETH",
    isValidAddress: (address: string) => /^0x[0-9a-fA-F]{40}$/.test(address),
  })),
}));

vi.mock("../../blockchain/triverify.js", () => ({
  verifyAddressExists: vi.fn(async () => ({ existsOnChain: true })),
}));

vi.mock("../auth/pinLockout.service.js", () => ({
  pinLockoutService: { assertPinAuthorized: vi.fn(async () => undefined) },
}));

vi.mock("../../queues/transaction.queue.js", () => ({
  transactionQueue: { add: vi.fn(async () => ({})) },
}));

import { prisma } from "../../config/database.js";
import { transactionQueue } from "../../queues/transaction.queue.js";
import { transactionService } from "./transaction.service.js";

let keySeq = 0;
const nextKey = () => `idem-key-${++keySeq}`;

const sendInput = (overrides: Record<string, unknown> = {}) => ({
  senderId: SENDER,
  recipientAccountId: RECIPIENT_ACCOUNT_ID,
  asset: "ETH",
  amount: "1.5",
  network: "ETH" as const,
  pin: "111111",
  idempotencyKey: nextKey(),
  ...overrides,
});

beforeEach(() => {
  accounts.clear();
  wallets.clear();
  transactions.clear();
  accounts.set(RECIPIENT_ACCOUNT_ID, { userId: "recipient-1", accountId: RECIPIENT_ACCOUNT_ID });
  wallets.set("recipient-1:ETH", { userId: "recipient-1", chain: "ETH", address: RECIPIENT_ADDRESS });
  vi.clearAllMocks();
});

describe("internal transfer idempotency (transactionService.send)", () => {
  it("creates a PENDING transaction carrying the idempotency key", async () => {
    const key = nextKey();

    const tx = await transactionService.send(sendInput({ idempotencyKey: key }));

    expect(tx.status).toBe("PENDING");
    expect(tx.recipientAddress).toBe(RECIPIENT_ADDRESS);
    expect(transactions.get(tx.id)!.idempotencyKey).toBe(key);
  });

  it("collapses a rapid double-tap (two concurrent requests, same key) into exactly one transaction", async () => {
    const key = nextKey();

    // Both requests in flight at once, like a double-tap racing the disabled
    // button or an axios timeout-and-retry.
    const [first, second] = await Promise.all([
      transactionService.send(sendInput({ idempotencyKey: key })),
      transactionService.send(sendInput({ idempotencyKey: key })),
    ]);

    expect(second.id).toBe(first.id);
    expect(transactions.size).toBe(1);
  });

  it("replays the original transaction for a sequential retry with the same key (no re-validation, no second row)", async () => {
    const key = nextKey();
    const first = await transactionService.send(sendInput({ idempotencyKey: key }));
    vi.mocked(prisma.transaction.create).mockClear();

    const retry = await transactionService.send(sendInput({ idempotencyKey: key }));

    expect(retry.id).toBe(first.id);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(transactions.size).toBe(1);
  });

  it("processes two distinct transfers submitted in quick succession, each with its own id and key", async () => {
    const [a, b] = await Promise.all([
      transactionService.send(sendInput({ amount: "1" })),
      transactionService.send(sendInput({ amount: "2" })),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(transactions.size).toBe(2);
    expect(transactions.get(a.id)!.amount).toBe("1");
    expect(transactions.get(b.id)!.amount).toBe("2");
    // Both were serialized through the wallet row lock and both committed.
    expect(transactions.get(a.id)!.status).toBe("PENDING");
    expect(transactions.get(b.id)!.status).toBe("PENDING");
  });

  it("rejects a key reused for a different transfer with 409", async () => {
    const key = nextKey();
    await transactionService.send(sendInput({ idempotencyKey: key, amount: "1.5" }));

    await expect(
      transactionService.send(sendInput({ idempotencyKey: key, amount: "99" })),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "This idempotency key was already used for a different transfer",
    });
    expect(transactions.size).toBe(1);
  });

  it("folds a lost unique-key race back to the original row when the params match", async () => {
    const key = nextKey();
    // The concurrent winner's row already committed, but every lookup this
    // request ran before the commit observed nothing — only the create can
    // now reveal it, via the unique constraint.
    transactions.set("tx-winner", {
      id: "tx-winner",
      senderId: SENDER,
      recipientAccountId: RECIPIENT_ACCOUNT_ID,
      recipientAddress: RECIPIENT_ADDRESS,
      asset: "ETH",
      amount: "1.5",
      network: "ETH",
      status: "PENDING",
      idempotencyKey: key,
    });
    vi.mocked(prisma.transaction.findUnique).mockResolvedValueOnce(null); // fast-path
    vi.mocked(prisma.transaction.findUnique).mockResolvedValueOnce(null); // reused-check
    vi.mocked(prisma.transaction.findUnique).mockResolvedValueOnce(null); // raced-check

    const result = await transactionService.send(sendInput({ idempotencyKey: key }));

    expect(result.id).toBe("tx-winner");
    expect(transactions.size).toBe(1);
  });

  it("still requires the PIN before any replay or creation", async () => {
    await expect(transactionService.send(sendInput({ pin: "" }))).rejects.toMatchObject({ statusCode: 400 });
    expect(transactions.size).toBe(0);
  });
});

describe("broadcast idempotency (transactionService.broadcast)", () => {
  it("returns the row instead of enqueueing a second broadcast on retry", async () => {
    const tx = await transactionService.send(sendInput());
    const signedTx = "0x" + "cd".repeat(16);

    await transactionService.broadcast(SENDER, tx.id, signedTx);
    await transactionService.broadcast(SENDER, tx.id, signedTx);

    expect(vi.mocked(transactionQueue.add)).toHaveBeenCalledTimes(1);
    expect(transactions.get(tx.id)!.status).toBe("PROCESSING");
  });

  it("lets only one of two concurrent broadcasts claim the enqueue", async () => {
    const tx = await transactionService.send(sendInput());
    const signedTx = "0x" + "cd".repeat(16);

    await Promise.all([
      transactionService.broadcast(SENDER, tx.id, signedTx),
      transactionService.broadcast(SENDER, tx.id, signedTx),
    ]);

    expect(vi.mocked(transactionQueue.add)).toHaveBeenCalledTimes(1);
  });
});
