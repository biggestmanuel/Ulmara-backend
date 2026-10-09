import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The transaction queue processor — the code that actually moves money.
//
// Proven live end to end (send -> PENDING -> broadcast -> PROCESSING -> worker
// picks it up -> chain RPC rejects a fake signature -> FAILED) but never unit
// tested, and it is the highest-consequence file in the repo: it is the only
// thing that turns a signed transaction into an on-chain one.
//
// BullMQ's Worker is constructed but never connected, so these tests capture the
// processor function off the constructor and call it directly. No Redis, no
// network, no database.
//
// The properties that matter, in order:
//
//  1. A broadcast that throws marks the row FAILED and re-throws, so BullMQ can
//     apply its retry policy. Swallowing the error would silently strand money.
//  2. A confirmed transaction creates EXACTLY ONE receipt, and does so via
//     upsert — a duplicate job must not create a second.
//  3. A transaction the chain cannot confirm is left alone and re-queued, never
//     written as COMPLETED.
//  4. Best-effort websocket delivery never fails a job whose chain effect
//     already succeeded.
//  5. Both parties are notified on completion, so the recipient's app updates.
// ---------------------------------------------------------------------------

const { prismaMock, queueMock, adapterMock, publishUserEvent, reportError, WorkerSpy, processorOf } =
  vi.hoisted(() => {
    const prismaMock = {
      transaction: {
        findUnique: vi.fn(),
        update: vi.fn(async () => ({})),
      },
      receipt: { upsert: vi.fn(async () => ({})) },
      accountId: { findUnique: vi.fn() },
    };
    const queueMock = { add: vi.fn(async () => ({})) };
    // A plain adapter the mocked getChainAdapter always returns. The one test that
    // needs an adapter WITHOUT sendSignedTransaction passes its own object via
    // mockResolvedValueOnce rather than deleting a property here: vi.clearAllMocks()
    // clears calls but cannot restore a deleted method, so a delete would leave
    // every later test looking at a permanently incomplete adapter.
    const adapterMock: {
      getTransactionStatus: ReturnType<typeof vi.fn>;
      sendSignedTransaction: ReturnType<typeof vi.fn>;
    } = { getTransactionStatus: vi.fn(), sendSignedTransaction: vi.fn() };
    let captured: ((job: unknown) => Promise<unknown>) | undefined;

    class FakeWorker {
      constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
        captured = processor;
      }
    }
    const WorkerSpy = vi.fn(function (this: unknown, ...args: unknown[]) {
      return new (FakeWorker as unknown as new (...a: unknown[]) => FakeWorker)(...(args as []));
    }) as unknown as typeof FakeWorker;

    return {
      prismaMock,
      queueMock,
      adapterMock,
      publishUserEvent: vi.fn(async () => {}),
      reportError: vi.fn(),
      WorkerSpy,
      processorOf: () => captured,
    };
  });

vi.mock("bullmq", () => ({ Worker: WorkerSpy }));
vi.mock("../queues/transaction.queue.js", () => ({ transactionQueue: queueMock }));
vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("../queues/index.js", () => ({ QUEUE_NAMES: { transactions: "transactions", ramp: "ramp" } }));
vi.mock("../config/database.js", () => ({ prisma: prismaMock }));
vi.mock("../chains/index.js", () => ({ getChainAdapter: vi.fn(async () => adapterMock) }));
vi.mock("../websocket/emit.js", () => ({ publishUserEvent }));
vi.mock("../config/sentry.js", () => ({ reportError }));
vi.mock("../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createTransactionWorker } = await import("./transaction.worker.js");

const TX = "tx-1";
const SENDER = "user-sender";

/** Boot the factory and hand back the processor it registered. */
async function processor() {
  createTransactionWorker();
  const p = processorOf();
  if (!p) throw new Error("processor was never registered");
  return p as (job: { id: string; name: string; data: Record<string, unknown> }) => Promise<{
    transactionId: string;
    status?: string;
    txHash?: string;
  }>;
}

const job = (data: Record<string, unknown>) => ({ id: "job-1", name: "n", data });

/** The row the worker looks up, in the shape it actually reads. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: TX,
    senderId: SENDER,
    recipientAccountId: "7756306567",
    network: "ETH",
    status: "PROCESSING",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.transaction.update.mockResolvedValue({});
  prismaMock.receipt.upsert.mockResolvedValue({});
  queueMock.add.mockResolvedValue({});
  publishUserEvent.mockResolvedValue(undefined);
  // Default: a live transaction that can be broadcast.
  adapterMock.sendSignedTransaction.mockResolvedValue({ txHash: "0xdeadbeef" });
  adapterMock.getTransactionStatus.mockResolvedValue("pending");
  prismaMock.transaction.findUnique.mockResolvedValue(row());
});

describe("transaction worker — the happy path", () => {
  it("broadcasts, stores the hash, and queues a status check", async () => {
    const run = await processor();
    const r = await run(job({ transactionId: TX, signedTx: "0x02f872ab" }));

    expect(r).toEqual({ transactionId: TX, txHash: "0xdeadbeef" });
    expect(adapterMock.sendSignedTransaction).toHaveBeenCalledWith("0x02f872ab");

    // PROCESSING first (so a crash mid-broadcast leaves a visible state), then
    // the hash once it is known.
    expect(prismaMock.transaction.update.mock.calls).toEqual([
      [{ where: { id: TX }, data: { status: "PROCESSING" } }],
      [{ where: { id: TX }, data: { txHash: "0xdeadbeef", status: "PROCESSING" } }],
    ]);

    expect(queueMock.add).toHaveBeenCalledWith(
      "check-transaction",
      { transactionId: TX, txHash: "0xdeadbeef", checkOnly: true },
      { delay: 10_000 },
    );
  });

  it("uses the adapter for the transaction's own network", async () => {
    const { getChainAdapter } = await import("../chains/index.js");
    prismaMock.transaction.findUnique.mockResolvedValue(row({ network: "BSC" }));
    await (await processor())(job({ transactionId: TX, signedTx: "0x02f872ab" }));
    expect(getChainAdapter).toHaveBeenCalledWith("BSC");
  });
});

describe("transaction worker — failures must not strand money", () => {
  it("marks FAILED and RE-THROWS when the broadcast throws", async () => {
    adapterMock.sendSignedTransaction.mockRejectedValue(new Error("replacement fee too low"));
    const run = await processor();

    // Re-throwing is what lets BullMQ apply its retry policy. If this were
    // swallowed the job would look successful and the money would be stranded.
    await expect(run(job({ transactionId: TX, signedTx: "0xbad" }))).rejects.toThrow(
      "replacement fee too low",
    );
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: TX },
      data: { status: "FAILED" },
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      "Transaction broadcast failed",
      { transactionId: TX },
    );
  });

  it("marks FAILED when the chain does not implement signed broadcast", async () => {
    // An adapter with NO sendSignedTransaction at all. Supplied as its own
    // object so the shared fixture is never left mutated. The worker's
    // `if (!adapter.sendSignedTransaction)` guard must catch this rather than
    // calling undefined.
    const { getChainAdapter } = await import("../chains/index.js");
    vi.mocked(getChainAdapter).mockResolvedValueOnce({
      getTransactionStatus: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof getChainAdapter>>);
    const run = await processor();
    await expect(run(job({ transactionId: TX, signedTx: "0x02f872ab" }))).rejects.toThrow(
      /not implemented for ETH/,
    );
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: TX },
      data: { status: "FAILED" },
    });
  });

  it("marks FAILED and throws when the job has no signedTx", async () => {
    // This path writes FAILED BEFORE the try block, so the assertion is that
    // it still writes it at all.
    const run = await processor();
    await expect(run(job({ transactionId: TX }))).rejects.toThrow(
      "Signed transaction is required before broadcast",
    );
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: TX },
      data: { status: "FAILED" },
    });
    expect(adapterMock.sendSignedTransaction).not.toHaveBeenCalled();
  });

  it("leaves the shared adapter fixture intact for the next test", () => {
    // Guards the fixture: the not-implemented test supplies its own adapter, so
    // the shared one must still be complete. A regression that mutated it would
    // otherwise surface as an unrelated failure much later.
    expect(typeof adapterMock.sendSignedTransaction).toBe("function");
    expect(typeof adapterMock.getTransactionStatus).toBe("function");
  });

  it("throws when the transaction row does not exist, writing nothing", async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(null);
    const run = await processor();
    await expect(run(job({ transactionId: TX, signedTx: "0x02f872ab" }))).rejects.toThrow(
      "Transaction not found",
    );
    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
  });

  it("still notifies the sender when the broadcast fails", async () => {
    adapterMock.sendSignedTransaction.mockRejectedValue(new Error("rpc down"));
    await (await processor())(job({ transactionId: TX, signedTx: "0xbad" })).catch(() => {});
    // Best-effort, but the sender must learn their transfer failed.
    expect(publishUserEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SENDER,
        payload: expect.objectContaining({ transactionId: TX, status: "FAILED" }),
      }),
    );
  });
});

describe("transaction worker — status checking", () => {
  beforeEach(() => {
    prismaMock.accountId.findUnique.mockResolvedValue({ userId: "user-recipient" });
  });

  it("marks COMPLETED, upserts one receipt, and notifies BOTH parties", async () => {
    adapterMock.getTransactionStatus.mockResolvedValue("confirmed");
    const run = await processor();
    const r = await run(job({ transactionId: TX, txHash: "0xhash", checkOnly: true }));

    expect(r).toEqual({ transactionId: TX, status: "confirmed" });
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: TX },
      data: { status: "COMPLETED" },
    });
    // upsert, not create: a duplicate check job must not make a second receipt.
    expect(prismaMock.receipt.upsert).toHaveBeenCalledWith({
      where: { transactionId: TX },
      update: {},
      create: { transactionId: TX },
    });

    // Asserted by exact payload rather than by mapping `.mock.calls`: the mock's
    // inferred parameter tuple is empty, so indexing a call's arguments does not
    // type-check. Both parties must appear, and the payload must carry the hash.
    expect(publishUserEvent).toHaveBeenCalledWith({
      userId: SENDER,
      event: "transaction:updated",
      payload: { transactionId: TX, status: "COMPLETED", txHash: "0xhash" },
    });
    expect(publishUserEvent).toHaveBeenCalledWith({
      userId: "user-recipient",
      event: "transaction:updated",
      payload: { transactionId: TX, status: "COMPLETED", txHash: "0xhash" },
    });
  });

  it("marks FAILED on a reverted transaction and creates NO receipt", async () => {
    adapterMock.getTransactionStatus.mockResolvedValue("failed");
    await (await processor())(job({ transactionId: TX, txHash: "0xhash", checkOnly: true }));

    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: TX },
      data: { status: "FAILED" },
    });
    // A receipt asserts value moved. A reverted transfer must not have one.
    expect(prismaMock.receipt.upsert).not.toHaveBeenCalled();
  });

  it("re-queues and writes NOTHING when the transaction is still in flight", async () => {
    adapterMock.getTransactionStatus.mockResolvedValue("pending");
    const run = await processor();
    const r = await run(job({ transactionId: TX, txHash: "0xhash", checkOnly: true }));

    expect(r).toEqual({ transactionId: TX, status: "pending" });
    // The load-bearing assertion: an unconfirmed chain must never be written
    // as COMPLETED, which would tell the user their money arrived.
    expect(prismaMock.transaction.update).not.toHaveBeenCalled();
    expect(prismaMock.receipt.upsert).not.toHaveBeenCalled();
    expect(publishUserEvent).not.toHaveBeenCalled();

    // `delay`, not a sleep, so a restart does not lose the pending check.
    expect(queueMock.add).toHaveBeenCalledWith(
      "check-transaction",
      { transactionId: TX, txHash: "0xhash", checkOnly: true },
      { delay: 10_000 },
    );
  });

  it("skips the recipient lookup when there is no recipient Account ID", async () => {
    prismaMock.transaction.findUnique.mockResolvedValue(row({ recipientAccountId: null }));
    adapterMock.getTransactionStatus.mockResolvedValue("confirmed");
    await (await processor())(job({ transactionId: TX, txHash: "0xhash", checkOnly: true }));

    expect(prismaMock.accountId.findUnique).not.toHaveBeenCalled();
    expect(publishUserEvent).toHaveBeenCalledTimes(1);
  });

  it("still succeeds when the recipient Account ID row has vanished", async () => {
    prismaMock.accountId.findUnique.mockResolvedValue(null);
    adapterMock.getTransactionStatus.mockResolvedValue("confirmed");
    // The recipient's record disappearing must not fail a settled transfer.
    await expect(
      (await processor())(job({ transactionId: TX, txHash: "0xhash", checkOnly: true })),
    ).resolves.toMatchObject({ status: "confirmed" });
  });

  it("does not treat a check-only job with no txHash as a broadcast", async () => {
    // checkOnly without a hash falls through to the broadcast branch, which
    // must then refuse rather than broadcast an undefined value.
    await expect(
      (await processor())(job({ transactionId: TX, checkOnly: true })),
    ).rejects.toThrow("Signed transaction is required before broadcast");
  });
});

describe("transaction worker — websocket delivery is best-effort", () => {
  it("does not fail a settled transfer because publishing threw", async () => {
    publishUserEvent.mockRejectedValue(new Error("redis down"));
    adapterMock.getTransactionStatus.mockResolvedValue("confirmed");

    // The on-chain effect already happened; a pub/sub failure must not make
    // the job retry, or the transfer would be re-checked for ever.
    await expect(
      (await processor())(job({ transactionId: TX, txHash: "0xhash", checkOnly: true })),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(prismaMock.transaction.update).toHaveBeenCalledWith({
      where: { id: TX },
      data: { status: "COMPLETED" },
    });
  });

  it("does not mask a broadcast failure behind a websocket failure", async () => {
    publishUserEvent.mockRejectedValue(new Error("redis down"));
    adapterMock.sendSignedTransaction.mockRejectedValue(new Error("reverted"));
    await expect(
      (await processor())(job({ transactionId: TX, signedTx: "0xbad" })),
    ).rejects.toThrow("reverted");
  });
});