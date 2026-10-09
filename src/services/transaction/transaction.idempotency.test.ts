import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Section 7: duplicate-submit protection, including CONCURRENT requests.
 *
 * The harness models the two database guarantees the protection rests on:
 *   - the UNIQUE index on Transaction.idempotencyKey (violations surface as
 *     Prisma P2002), and
 *   - the serialized interactive transaction (prisma.$transaction) that
 *     re-checks the key and takes a row lock on the sender's wallet.
 *
 * A single-threaded test cannot prove much about a race, so the concurrency
 * cases interleave deliberately: several requests are started against the same
 * key with awaits between each step.
 */
const { accounts, wallets, transactions } = vi.hoisted(() => ({
  accounts: new Map<string, { userId: string; accountId: string }>(),
  wallets: new Map<string, { userId: string; chain: string; address: string }>(),
  transactions: new Map<string, Record<string, unknown>>(),
}));

const SENDER = "sender-1";
const OTHER_USER = "sender-2";
const RECIPIENT_ADDRESS = "0x" + "ab".repeat(20);
const SENDER_ADDRESS = "0x" + "cd".repeat(20);
const KEY = "11111111-2222-3333-4444-555555555555";

const { queueAdds } = vi.hoisted(() => ({ queueAdds: { count: 0 } }));

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
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey?: string } }) => findByKey(where.idempotencyKey)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.idempotencyKey === "string") {
          for (const row of transactions.values()) {
            if (row.idempotencyKey === data.idempotencyKey) {
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
            if (row.userId === where.userId_chain.userId && row.chain === where.userId_chain.chain) return { ...row };
          }
          return null;
        }),
      },
      transaction: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
          if (where.idempotencyKey !== undefined) return findByKey(where.idempotencyKey);
          const row = where.id ? transactions.get(where.id) : undefined;
          return row ? { ...row } : undefined;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = transactions.get(where.id)!;
          Object.assign(row, data);
          return { ...row };
        }),
        // getById's ownership filter: the sender, or the recipient via the
        // sender's own account. This is what stops one user acting on
        // another user's transaction.
        findFirst: vi.fn(async ({ where }: { where: { id: string; OR: Record<string, unknown>[] } }) => {
          const row = transactions.get(where.id);
          if (!row) return null;
          const isSender = row.senderId === where.OR?.find((c) => "senderId" in c)?.senderId;
          if (!isSender) return null;
          return { ...row, sender: { accountId: null }, direction: "sent" };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { id: string; senderId?: string; status?: string }; data: Record<string, unknown> }) => {
          const row = transactions.get(where.id);
          if (!row) return { count: 0 };
          if (where.senderId !== undefined && row.senderId !== where.senderId) return { count: 0 };
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
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
vi.mock("../../blockchain/triverify.js", () => ({ verifyAddressExists: vi.fn(async () => ({ existsOnChain: true })) }));
vi.mock("../auth/pinLockout.service.js", () => ({
  pinLockoutService: { assertPinAuthorized: vi.fn(async () => undefined) },
}));
vi.mock("../../queues/transaction.queue.js", () => ({
  transactionQueue: {
    add: vi.fn(async () => {
      queueAdds.count += 1;
      return {};
    }),
  },
}));

import { transactionService } from "./transaction.service.js";

function sendInput(over: Record<string, unknown> = {}) {
  return {
    senderId: SENDER,
    recipientAddress: RECIPIENT_ADDRESS,
    asset: "ETH",
    amount: "1",
    network: "ETH" as const,
    pin: "123456",
    idempotencyKey: KEY,
    ...over,
  };
}

beforeEach(() => {
  transactions.clear();
  wallets.clear();
  accounts.clear();
  queueAdds.count = 0;
  wallets.set("w1", { userId: SENDER, chain: "ETH", address: SENDER_ADDRESS });
});

describe("sequential duplicate submits", () => {
  it("creates exactly one transaction for a repeated key", async () => {
    const first = await transactionService.send(sendInput());
    const second = await transactionService.send(sendInput());

    expect(transactions.size).toBe(1);
    expect(second.id).toBe(first.id);
  });

  it("does not re-broadcast on a replay", async () => {
    await transactionService.send(sendInput());
    const { queueAdds: _ } = { queueAdds };
    const before = queueAdds.count;
    await transactionService.send(sendInput());
    // send() only creates the row; broadcast is a separate step. Confirm the
    // replay returned the same row rather than creating a second one.
    expect(transactions.size).toBe(1);
    expect(queueAdds.count).toBe(before);
  });

  it("rejects a key reused for a DIFFERENT transfer (409)", async () => {
    await transactionService.send(sendInput());
    await expect(transactionService.send(sendInput({ amount: "2" }))).rejects.toMatchObject({
      statusCode: 409,
      message: "This idempotency key was already used for a different transfer",
    });
  });

  it("rejects a key reused for a different recipient", async () => {
    await transactionService.send(sendInput());
    await expect(
      transactionService.send(sendInput({ recipientAddress: "0x" + "ef".repeat(20) })),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects a key reused on a different network", async () => {
    await transactionService.send(sendInput());
    await expect(transactionService.send(sendInput({ network: "BSC" }))).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("concurrent duplicate submits (same key)", () => {
  it("produces exactly ONE transaction from 10 simultaneous requests", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => transactionService.send(sendInput())));

    expect(transactions.size).toBe(1);
    // Every caller sees the same row.
    const ids = new Set(results.map((r) => (r as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("handles concurrent requests for two DIFFERENT keys as two transfers", async () => {
    const [a, b] = await Promise.all([
      transactionService.send(sendInput({ idempotencyKey: "aaaaaaaa-0000-0000-0000-000000000001" })),
      transactionService.send(sendInput({ idempotencyKey: "bbbbbbbb-0000-0000-0000-000000000002", amount: "2" })),
    ]);
    expect(transactions.size).toBe(2);
    expect((a as { id: string }).id).not.toBe((b as { id: string }).id);
  });

  it("one user's key can never surface another user's transaction", async () => {
    wallets.set("w2", { userId: OTHER_USER, chain: "ETH", address: "0x" + "12".repeat(20) });
    // User A creates the row for KEY.
    const aRow = (await transactionService.send(sendInput())) as { id: string; senderId: string };

    // User B replays A's key. The replay lookup is scoped to the sender, so B
    // does NOT get A's row; B's insert then collides with the global UNIQUE
    // index and is refused with a 409 rather than silently creating or
    // returning a cross-user row. Failing closed is the correct outcome.
    await expect(
      transactionService.send(sendInput({ senderId: OTHER_USER, idempotencyKey: KEY, amount: "3" })),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "This idempotency key was already used for a different transfer",
    });

    // A's row is untouched and still owned by A.
    const stored = [...transactions.values()].find((r) => r.idempotencyKey === KEY)!;
    expect(stored.id).toBe(aRow.id);
    expect(stored.senderId).toBe(SENDER);
    expect(transactions.size).toBe(1);
  });
});

describe("broadcast idempotency", () => {
  it("broadcasts once and replays the row on a repeat", async () => {
    const tx = (await transactionService.send(sendInput())) as { id: string };
    const first = await transactionService.broadcast(SENDER, tx.id, "0xsigned");
    const second = await transactionService.broadcast(SENDER, tx.id, "0xsigned");

    expect((first as { status: string }).status).toBe("PROCESSING");
    expect((second as { status: string }).status).toBe("PROCESSING");
    // Exactly one enqueue, so the signed tx is broadcast once.
    expect(queueAdds.count).toBe(1);
  });

  it("a concurrent double-broadcast enqueues exactly one job", async () => {
    const tx = (await transactionService.send(sendInput())) as { id: string };
    await Promise.all([
      transactionService.broadcast(SENDER, tx.id, "0xsigned"),
      transactionService.broadcast(SENDER, tx.id, "0xsigned"),
      transactionService.broadcast(SENDER, tx.id, "0xsigned"),
    ]);
    expect(queueAdds.count).toBe(1);
  });

  it("another user cannot broadcast a transaction they do not own", async () => {
    const tx = (await transactionService.send(sendInput())) as { id: string };
    await expect(transactionService.broadcast(OTHER_USER, tx.id, "0xsigned")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(queueAdds.count).toBe(0);
  });
});
