import { ethers } from "ethers";
import { prisma } from "../../config/database.js";
import { env } from "../../config/env.js";
import { getChainAdapter, type ChainName } from "../../chains/index.js";
import { verifyAddressExists } from "../../blockchain/triverify.js";
import { pinLockoutService } from "../auth/pinLockout.service.js";
import { transactionService } from "./transaction.service.js";
import { transactionQueue } from "../../queues/transaction.queue.js";
import { logger } from "../../config/logger.js";

// One-time window on prepared intents: long enough for a user to review,
// sign on-device, and submit; short enough that a prepared-but-unsigned
// recipient/amount pair goes stale quickly.
const INTENT_TTL_MS = 10 * 60 * 1000;

// Native-only assets per chain for now (matches the adapters and the
// frontend signer, which supports native ETH transfers only).
const NATIVE_ASSETS: Record<string, string> = {
  TON: "TON",
  BSC: "BNB",
  ETH: "ETH",
  SOL: "SOL",
  BASE: "ETH",
  POLYGON: "POL",
  TRON: "TRX",
  BTC: "BTC",
};

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

export interface PrepareExternalTransferInput {
  userId: string;
  chain: ChainName;
  asset: string;
  amount: string;
  to: string;
  pin: string;
}

export interface PreparedExternalTransfer {
  id: string;
  chain: ChainName;
  asset: string;
  amount: string;
  to: string;
  fee: string;
  status: "READY";
}

export const externalTransferService = {
  // Validate recipient (format + TriVerify on-chain existence), authorize the
  // PIN, price the transfer, and persist a single-use intent. Nothing here
  // moves funds — the client signs locally and comes back to /submit.
  async prepare(input: PrepareExternalTransferInput): Promise<PreparedExternalTransfer> {
    const adapter = await getChainAdapter(input.chain);

    // Native assets only until ERC-20/SPL support lands; rejecting early
    // keeps an unsupported asset from ever reaching a persisted intent.
    const native = NATIVE_ASSETS[input.chain];
    if (!native || input.asset !== native) {
      fail(400, `${input.asset} transfers are not supported on ${input.chain}`);
    }

    if (!adapter.isValidAddress(input.to)) {
      fail(400, "Recipient address failed validation");
    }

    // Same gate as internal transfers: 5 wrong PINs -> 15-minute lockout.
    // Deliberately placed before the TriVerify lookup so a caller without the
    // PIN cannot use this endpoint to probe arbitrary addresses, while a
    // malformed request still never burns a PIN attempt.
    // A wrong PIN must never leave an intent behind.
    await pinLockoutService.assertPinAuthorized(input.userId, input.pin);

    // TriVerify (with RPC fallback): proves the address exists/is active on
    // the target chain and blocks cross-chain paste mistakes.
    await verifyAddressExists(input.to, input.chain);

    const wallet = await prisma.wallet.findUnique({
      where: { userId_chain: { userId: input.userId, chain: input.chain } },
    });
    if (!wallet) fail(400, `You have no wallet on ${input.chain}`);

    let fee: string;
    try {
      fee = await adapter.estimateFee({
        fromAddress: wallet.address,
        toAddress: input.to,
        asset: input.asset,
        amount: input.amount,
      });
    } catch (err) {
      logger.warn({ err, chain: input.chain }, "external/prepare: fee estimation failed");
      fail(502, "Could not estimate the network fee right now. Try again shortly.");
    }

    const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
    const intent = await prisma.externalTransferIntent.create({
      data: {
        userId: input.userId,
        chain: input.chain,
        asset: input.asset,
        amount: input.amount,
        recipient: input.to,
        fee,
        status: "READY",
        expiresAt,
      },
    });

    return {
      id: intent.id,
      chain: input.chain,
      asset: input.asset,
      amount: input.amount,
      to: input.to,
      fee,
      status: "READY",
    };
  },

  // Consume a prepared intent: decode the client-signed transaction, verify
  // every money-moving field against the stored intent (never trust the
  // client), then create the ledger row and enqueue the broadcast.
  // `idempotencyKey` (client UUID, one per attempt) makes retries after a
  // lost response return the original transaction instead of creating a
  // second ledger row and broadcasting the same signature twice.
  async submit(userId: string, intentId: string, signedTx: string, idempotencyKey: string): Promise<unknown> {
    // Replay fast-path: the original submit created its row, but the response
    // was lost (mobile network timeout). Return that row unchanged — no new
    // transfer, no second broadcast. Deliberately before the single-use claim.
    const existing = await transactionService.findByIdempotencyKey(idempotencyKey, userId);
    if (existing) return { ...existing, direction: "sent", counterpartyAccountId: existing.recipientAddress };

    // Atomic single-use claim: exactly one request can flip READY -> USED.
    // Replays and concurrent submits lose the update and are rejected below.
    const claimed = await prisma.externalTransferIntent.updateMany({
      where: {
        id: intentId,
        userId,
        status: "READY",
        expiresAt: { gt: new Date() },
      },
      data: { status: "USED", usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      // Two requests carrying the SAME new idempotency key both passed the
      // replay check and raced the claim; the loser's key is not a replay yet.
      // Re-check before rejecting so it replays the winner's row.
      const raced = await transactionService.findByIdempotencyKey(idempotencyKey, userId);
      if (raced) return { ...raced, direction: "sent", counterpartyAccountId: raced.recipientAddress };

      const intent = await prisma.externalTransferIntent.findUnique({ where: { id: intentId } });
      if (!intent || intent.userId !== userId) fail(404, "Transfer intent not found");
      if (intent!.status === "USED") fail(409, "This transfer was already submitted");
      if (intent!.expiresAt.getTime() <= new Date().getTime()) {
        fail(410, "This transfer intent has expired. Start the transfer again.");
      }
      fail(409, "This transfer can no longer be submitted");
    }

    // Claim succeeded — run the verification and ledger write. Failure handling
    // depends on how far we got:
    // - verification/decode failure (nothing persisted): roll the intent back
    //   to READY so the same signature can be resubmitted after a client fix;
    // - failure after the Transaction row exists: mark it FAILED (audit trail)
    //   and keep the intent USED so a retry can never double-create rows.
    let createdTransactionId: string | null = null;
    try {
      const intent = (await prisma.externalTransferIntent.findUnique({ where: { id: intentId } }))!;
      const verified = await this.verifySignedTransaction(intent, signedTx);

      let transaction;
      try {
        transaction = await prisma.transaction.create({
          data: {
            senderId: userId,
            recipientAddress: intent.recipient,
            asset: intent.asset,
            amount: intent.amount,
            network: intent.chain,
            status: "PENDING",
            idempotencyKey,
          },
        });
      } catch (err: any) {
        // Lost a unique-constraint race on the key: another concurrent request
        // (same client retrying, or a second device) created the row first.
        if (err?.code !== "P2002") throw err;
        const winner = await transactionService.findByIdempotencyKey(idempotencyKey, userId);
        if (!winner) throw err;
        // Release this intent: it was consumed by a duplicate, so the honest
        // retry path must not see it as permanently spent.
        await prisma.externalTransferIntent.updateMany({
          where: { id: intentId, status: "USED", transactionId: null },
          data: { status: "READY", usedAt: null },
        }).catch(() => undefined);
        return { ...winner, direction: "sent", counterpartyAccountId: winner.recipientAddress };
      }
      createdTransactionId = transaction.id;

      await prisma.externalTransferIntent.update({
        where: { id: intentId },
        data: { transactionId: transaction.id },
      });

      await transactionQueue.add("process-transaction", { transactionId: transaction.id, signedTx });
      logger.info(
        { transactionId: transaction.id, intentId, verified },
        "external transfer submitted (signed tx verified against intent)",
      );

      // Shape mirrors transactionService.list/getById's sent-mapping so the
      // client's transaction store can upsert the row directly.
      return {
        ...transaction,
        direction: "sent",
        counterpartyAccountId: intent.recipient,
      };
    } catch (err) {
      if (createdTransactionId) {
        await prisma.transaction.update({
          where: { id: createdTransactionId },
          data: { status: "FAILED" },
        }).catch(() => undefined);
      } else {
        await prisma.externalTransferIntent.updateMany({
          where: { id: intentId, status: "USED", transactionId: null },
          data: { status: "READY", usedAt: null },
        }).catch(() => undefined);
      }
      throw err;
    }
  },

  // Decode the signed transaction and compare it to the intent. Any mismatch
  // in recipient, amount, chain, asset, or an unexpected data field fails the
  // submit without broadcasting.
  async verifySignedTransaction(
    // amount is Prisma's Decimal at the call site; only its string form matters.
    intent: { chain: string; asset: string; amount: { toString(): string }; recipient: string },
    signedTx: string,
  ): Promise<{ to: string; value: string; chainId: string }> {
    const isEvm = intent.chain === "ETH" || intent.chain === "BSC" || intent.chain === "BASE" || intent.chain === "POLYGON";
    if (!isEvm) {
      fail(400, `Signed-transaction verification is not implemented for ${intent.chain}`);
    }

    let parsed: ethers.Transaction;
    try {
      parsed = ethers.Transaction.from(signedTx);
    } catch {
      fail(400, "The signed transaction could not be decoded");
    }

    const recipient = parsed.to;
    if (
      recipient === null ||
      recipient.toLowerCase() !== intent.recipient.toLowerCase() ||
      parsed.value !== ethers.parseUnits(intent.amount.toString(), 18)
    ) {
      fail(400, "The signed transaction does not match the prepared transfer");
    }

    // ethers >= 6.16 types chainId as bigint.
    if (parsed.chainId !== BigInt(getEvmChainId(intent.chain))) {
      fail(400, "The signed transaction targets a different network than the prepared transfer");
    }

    // Native transfers only: contract data would change what the tx does.
    if (parsed.data && parsed.data !== "0x") {
      fail(400, "The signed transaction contains unexpected data");
    }

    return { to: recipient, value: parsed.value.toString(), chainId: parsed.chainId.toString() };
  },
};

// Expected chainId for signed-transaction verification. Every value is
// env-driven so a network switch (e.g. ETH Sepolia -> mainnet at go-live) is
// a config change, never a code change. BSC/Base/Polygon currently have no
// testnet phase, so their env overrides are optional.
function getEvmChainId(chain: string): number {
  switch (chain) {
    case "ETH": return env.ETHEREUM_CHAIN_ID;
    case "BSC": return env.BSC_CHAIN_ID ?? 56;
    case "BASE": return env.BASE_CHAIN_ID ?? 8453;
    case "POLYGON": return env.POLYGON_CHAIN_ID ?? 137;
    // Unreachable in practice: verifySignedTransaction already checks the
    // chain is one of the four EVM networks before calling this.
    default: throw Object.assign(new Error(`Not an EVM chain: ${chain}`), { statusCode: 400 });
  }
}
