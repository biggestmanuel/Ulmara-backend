import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// The real externalTransferService AND the real pinLockoutService run here.
// Mocked: prisma (in-memory model), the ETH chain adapter, TriVerify, the
// BullMQ queue, and the logger. Signed-transaction fixtures are produced by a
// real ethers throwaway wallet, so the decode-and-verify path runs for real.
// ---------------------------------------------------------------------------

const LOCKOUT_MS = 15 * 60 * 1000;
const START = 1_700_000_000_000;

const { users, intents, ethAdapter } = vi.hoisted(() => {
  // prisma.user model — drives the real pinLockoutService.
  const users = new Map<
    string,
    { pinHash: string | null; pinFailedAttempts: number; pinLockedUntil: Date | null }
  >();
  // prisma.externalTransferIntent model.
  const intents = new Map<
    string,
    {
      id: string;
      userId: string;
      chain: string;
      asset: string;
      amount: number;
      recipient: string;
      fee: string | null;
      status: "READY" | "USED";
      expiresAt: Date;
      usedAt: Date | null;
      transactionId: string | null;
    }
  >();
  const ethAdapter = {
    chain: "ETH",
    isValidAddress: (address: string) => /^0x[0-9a-fA-F]{40}$/.test(address),
    estimateFee: async () => "0.00021",
  };
  return { users, intents, ethAdapter };
});

vi.mock("../../config/database.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = users.get(where.id);
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; pinFailedAttempts?: number };
          data: { pinFailedAttempts?: number; pinLockedUntil?: Date | null };
        }) => {
          const row = users.get(where.id);
          if (!row) return { count: 0 };
          if (where.pinFailedAttempts !== undefined && row.pinFailedAttempts !== where.pinFailedAttempts) {
            return { count: 0 };
          }
          if (data.pinFailedAttempts !== undefined) row.pinFailedAttempts = data.pinFailedAttempts;
          if (data.pinLockedUntil !== undefined) row.pinLockedUntil = data.pinLockedUntil;
          return { count: 1 };
        },
      ),
    },
    externalTransferIntent: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => intents.get(where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `intent-${intents.size + 1}`;
        const row = {
          id,
          userId: data.userId as string,
          chain: data.chain as string,
          asset: data.asset as string,
          amount: data.amount as number,
          recipient: data.recipient as string,
          fee: data.fee as string | null,
          status: (data.status ?? "READY") as "READY" | "USED",
          expiresAt: data.expiresAt as Date,
          usedAt: null as Date | null,
          transactionId: null as string | null,
        };
        intents.set(id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { transactionId?: string | null } }) => {
        const row = intents.get(where.id);
        if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
        if (data.transactionId !== undefined) row.transactionId = data.transactionId;
        return { ...row };
      }),
      // Mirrors the real filter, including the expiry comparison behind the
      // single-use claim and the rollback guard (status USED, tx null).
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; userId?: string; status?: string; expiresAt?: { gt: Date } };
          data: { status?: string; usedAt?: Date | null };
        }) => {
          const row = intents.get(where.id);
          if (!row) return { count: 0 };
          if (where.userId !== undefined && row.userId !== where.userId) return { count: 0 };
          if (where.status !== undefined && row.status !== where.status) return { count: 0 };
          if (where.expiresAt?.gt && row.expiresAt.getTime() <= where.expiresAt.gt.getTime()) {
            return { count: 0 };
          }
          if (data.status !== undefined) row.status = data.status as "READY" | "USED";
          if (data.usedAt !== undefined) row.usedAt = data.usedAt;
          return { count: 1 };
        },
      ),
    },
    wallet: {
      findUnique: vi.fn(async () => ({ address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", chain: "ETH" })),
    },
    transaction: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `tx-${(data.recipientAddress as string).slice(2, 5)}-${Math.random().toString(16).slice(2, 8)}`,
        ...data,
      })),
      update: vi.fn(async () => ({})),
    },
  },
}));

vi.mock("../../chains/index.js", () => ({
  getChainAdapter: vi.fn(async () => ethAdapter),
}));

vi.mock("../../blockchain/triverify.js", () => ({
  verifyAddressExists: vi.fn(async () => ({
    address: "0x1",
    chain: "ETH",
    formatValid: true,
    existsOnChain: true,
    active: true,
    source: "mock",
  })),
}));

vi.mock("../../queues/transaction.queue.js", () => ({
  transactionQueue: { add: vi.fn(async () => ({})) },
}));

vi.mock("../../config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "../../config/database.js";
import { verifyAddressExists } from "../../blockchain/triverify.js";
import { transactionQueue } from "../../queues/transaction.queue.js";
import { pinLockoutService, PIN_LOCKOUT_MS } from "../auth/pinLockout.service.js";
import { externalTransferService } from "./externalTransfer.service.js";

const CORRECT_PIN = "111111";
const WRONG_PIN = "999999";
// Real bcrypt hash so the genuine pinLockoutService comparison passes.
const CORRECT_PIN_HASH = bcrypt.hashSync(CORRECT_PIN, 4);
const RECIPIENT = "0x00000000000000000000000000000000c0ffee01";
const AMOUNT = "1.5";

// Throwaway signer: a fixed private key keeps the fixture deterministic and
// avoids any mnemonic/HD derivation in tests.
const signer = new ethers.Wallet("0x" + "11".repeat(32));

async function signEthTransfer(input: { to: string; amount: string; chainId?: number }): Promise<string> {
  return signer.signTransaction({
    to: input.to,
    value: ethers.parseEther(input.amount),
    nonce: 0,
    chainId: input.chainId ?? 1,
    gasLimit: 21_000n,
    maxFeePerGas: ethers.parseUnits("30", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
  });
}

const prepareInput = (pin: string, overrides: Record<string, unknown> = {}) => ({
  userId: "user-1",
  chain: "ETH" as const,
  asset: "ETH",
  amount: AMOUNT,
  to: RECIPIENT,
  pin,
  ...overrides,
});

const freshUser = (pinHash: string | null = CORRECT_PIN_HASH) => {
  const id = `user-${users.size + 1}`;
  users.set(id, { pinHash, pinFailedAttempts: 0, pinLockedUntil: null });
  return id;
};

beforeEach(() => {
  users.clear();
  intents.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.clearAllMocks();
});

describe("external transfer prepare", () => {
  it("rejects a wrong PIN with 401 and creates no intent", async () => {
    const userId = freshUser();

    await expect(externalTransferService.prepare(prepareInput(WRONG_PIN, { userId }))).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(intents.size).toBe(0);
    expect(users.get(userId)!.pinFailedAttempts).toBe(1);
  });

  it("rejects a TriVerify-flagged recipient (nonexistent on chain) at prepare and creates no intent", async () => {
    const userId = freshUser();
    vi.mocked(verifyAddressExists).mockRejectedValueOnce(
      Object.assign(new Error("Address could not be verified on ETH"), { statusCode: 400 }),
    );

    await expect(externalTransferService.prepare(prepareInput(CORRECT_PIN, { userId }))).rejects.toMatchObject({
      statusCode: 400,
      message: "Address could not be verified on ETH",
    });
    expect(intents.size).toBe(0);
    // The PIN was correct: the counter must have been reset, not consumed.
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
    expect(vi.mocked(verifyAddressExists).mock.calls[0]).toEqual([RECIPIENT, "ETH"]);
  });

  it("happy path: validates address (format + TriVerify), gates the PIN, persists a READY intent, returns the frontend contract shape", async () => {
    const userId = freshUser();

    const result = await externalTransferService.prepare(prepareInput(CORRECT_PIN, { userId }));

    expect(result).toEqual({
      id: expect.any(String),
      chain: "ETH",
      asset: "ETH",
      amount: AMOUNT,
      to: RECIPIENT,
      fee: "0.00021",
      status: "READY",
    });

    const intent = intents.get(result.id)!;
    expect(intent).toMatchObject({
      userId,
      chain: "ETH",
      asset: "ETH",
      // The in-memory model stores the raw input; real Prisma persists it as
      // Decimal(36,18) — either way the string form is "1.5".
      amount: "1.5",
      recipient: RECIPIENT,
      fee: "0.00021",
      status: "READY",
    });
    expect(intent.expiresAt.getTime()).toBe(START + 10 * 60 * 1000); // 10-minute window
  });

  it("rejects an address that fails the adapter format check before any PIN attempt", async () => {
    const userId = freshUser();

    await expect(
      externalTransferService.prepare(prepareInput(CORRECT_PIN, { userId, to: "not-an-address" })),
    ).rejects.toMatchObject({ statusCode: 400, message: "Recipient address failed validation" });

    expect(vi.mocked(verifyAddressExists)).not.toHaveBeenCalled();
    expect(intents.size).toBe(0);
    // Format errors are client mistakes, not PIN attempts.
    expect(users.get(userId)!.pinFailedAttempts).toBe(0);
  });
});

describe("external transfer submit", () => {
  async function prepareIntent(userId: string) {
    return externalTransferService.prepare(prepareInput(CORRECT_PIN, { userId }));
  }

  it("verifies a matching signed transaction, creates the ledger row, and enqueues the broadcast", async () => {
    const userId = freshUser();
    const prepared = await prepareIntent(userId);
    const signedTx = await signEthTransfer({ to: RECIPIENT, amount: AMOUNT });

    const result = (await externalTransferService.submit(userId, prepared.id, signedTx)) as {
      id: string;
      status: string;
      recipientAddress: string;
    };

    expect(result.recipientAddress).toBe(RECIPIENT);
    expect(result.status).toBe("PENDING");

    const createdRow = vi.mocked(prisma.transaction.create).mock.calls[0][0].data as Record<string, unknown>;
    expect(createdRow).toMatchObject({
      senderId: userId,
      recipientAddress: RECIPIENT,
      asset: "ETH",
      network: "ETH",
      status: "PENDING",
    });

    expect(vi.mocked(transactionQueue.add)).toHaveBeenCalledWith(
      "process-transaction",
      { transactionId: result.id, signedTx },
    );

    const intent = intents.get(prepared.id)!;
    expect(intent.status).toBe("USED");
    expect(intent.usedAt).not.toBeNull();
    expect(intent.transactionId).toBe(result.id);
  });

  it("rejects a tampered submit (signature for different recipient/amount/chain) and rolls the intent back to READY", async () => {
    const userId = freshUser();
    const prepared = await prepareIntent(userId);

    // The attacker swapped the recipient to their own address before signing.
    const tampered = await signEthTransfer({ to: "0x00000000000000000000000000000000deadbeef", amount: AMOUNT });
    await expect(externalTransferService.submit(userId, prepared.id, tampered)).rejects.toMatchObject({
      statusCode: 400,
      message: "The signed transaction does not match the prepared transfer",
    });

    // Nothing was broadcast and no ledger row exists.
    expect(vi.mocked(transactionQueue.add)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.transaction.create)).not.toHaveBeenCalled();
    // The intent returned to READY so the honest client can retry.
    expect(intents.get(prepared.id)!.status).toBe("READY");

    // Same story for an amount swap and a wrong-network signature.
    const amountTampered = await signEthTransfer({ to: RECIPIENT, amount: "99" });
    await expect(externalTransferService.submit(userId, prepared.id, amountTampered)).rejects.toMatchObject({
      statusCode: 400,
    });
    const wrongChain = await signEthTransfer({ to: RECIPIENT, amount: AMOUNT, chainId: 56 });
    await expect(externalTransferService.submit(userId, prepared.id, wrongChain)).rejects.toMatchObject({
      statusCode: 400,
      message: "The signed transaction targets a different network than the prepared transfer",
    });
    expect(intents.get(prepared.id)!.status).toBe("READY");
  });

  it("rejects a reused intent (single-use) and an expired intent", async () => {
    const userId = freshUser();
    const prepared = await prepareIntent(userId);
    const signedTx = await signEthTransfer({ to: RECIPIENT, amount: AMOUNT });

    // First submit goes through...
    await externalTransferService.submit(userId, prepared.id, signedTx);
    const txCountAfterFirst = vi.mocked(prisma.transaction.create).mock.calls.length;

    // ...a replay with even a valid signature is rejected: 409, no new row.
    await expect(externalTransferService.submit(userId, prepared.id, signedTx)).rejects.toMatchObject({
      statusCode: 409,
      message: "This transfer was already submitted",
    });
    expect(vi.mocked(prisma.transaction.create).mock.calls.length).toBe(txCountAfterFirst);

    // Expired intent (11 minutes old) is rejected with 410.
    const secondUser = freshUser();
    const stale = await prepareIntent(secondUser);
    vi.setSystemTime(START + 11 * 60 * 1000);
    await expect(externalTransferService.submit(secondUser, stale.id, signedTx)).rejects.toMatchObject({
      statusCode: 410,
    });
    expect(vi.mocked(prisma.transaction.create).mock.calls.length).toBe(txCountAfterFirst);
  });

  it("rejects an intent belonging to another user, and a decode failure", async () => {
    const owner = freshUser();
    const prepared = await prepareIntent(owner);
    const attacker = freshUser();

    await expect(
      externalTransferService.submit(attacker, prepared.id, await signEthTransfer({ to: RECIPIENT, amount: AMOUNT })),
    ).rejects.toMatchObject({ statusCode: 404, message: "Transfer intent not found" });

    // Undecodable blob: 400, intent still READY (retryable).
    await expect(externalTransferService.submit(owner, prepared.id, "not-a-signed-transaction")).rejects.toMatchObject({
      statusCode: 400,
      message: "The signed transaction could not be decoded",
    });
    expect(intents.get(prepared.id)!.status).toBe("READY");
  });
});

describe("external flow lockout integration", () => {
  it("five wrong PINs on prepare lock the user out of transfers entirely", async () => {
    const userId = freshUser();

    for (let i = 0; i < 4; i++) {
      await expect(externalTransferService.prepare(prepareInput(WRONG_PIN, { userId }))).rejects.toMatchObject({
        statusCode: 401,
      });
    }
    const fifth = externalTransferService.prepare(prepareInput(WRONG_PIN, { userId }));
    await expect(fifth).rejects.toMatchObject({ statusCode: 423 });

    // Locked out: even the correct PIN is rejected on BOTH external and send paths.
    await expect(externalTransferService.prepare(prepareInput(CORRECT_PIN, { userId }))).rejects.toMatchObject({
      statusCode: 423,
    });
    await expect(pinLockoutService.assertPinAuthorized(userId, CORRECT_PIN)).rejects.toMatchObject({
      statusCode: 423,
    });

    // After the cooldown the correct PIN authorizes again.
    vi.setSystemTime(START + LOCKOUT_MS + 1);
    await expect(pinLockoutService.assertPinAuthorized(userId, CORRECT_PIN)).resolves.toBeUndefined();
    expect(users.get(userId)!.pinLockedUntil).toBeNull();
  });
});
