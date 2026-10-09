import { ethers } from "ethers";
import { prisma } from "../../config/database.js";
import { getChainAdapter, type ChainName } from "../../chains/index.js";
import { getEvmChainId, isEvmChain, nativeAssetFor } from "../../chains/chain.network.js";
import { listTokens, resolveToken, type TokenConfig } from "../../chains/tokens/registry.js";
import { verifyAddressExists } from "../../blockchain/triverify.js";
import { pinLockoutService } from "../auth/pinLockout.service.js";
import { transactionService } from "./transaction.service.js";
import { transactionQueue } from "../../queues/transaction.queue.js";
import { logger } from "../../config/logger.js";
import { HttpError } from "../../utils/apiResponse.js";
import { isUniqueConstraintViolation } from "../../utils/prismaError.js";
import { toBaseUnits } from "../../utils/money.js";

// One-time window on prepared intents: long enough for a user to review,
// sign on-device, and submit; short enough that a prepared-but-unsigned
// recipient/amount pair goes stale quickly.
const INTENT_TTL_MS = 10 * 60 * 1000;

/** Native-only assets per chain, for chains with no ERC-20 registry. */
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

// HttpError, not a plain Error with a statusCode property: it is how the
// codebase marks a message as deliberately written for the user, and
// handleError only surfaces a 5xx message when the error is an HttpError. The
// previous Object.assign form made every one of these deliberate messages
// unreachable — a 503 whose text explained the outage reached the client as
// "Something went wrong".
function fail(statusCode: number, message: string): never {
  throw new HttpError(statusCode, message);
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
  /** Present only for ERC-20 transfers: the contract + calldata to sign. */
  token?: {
    symbol: string;
    address: string;
    decimals: number;
    contract: string;
    callData: string;
  };
}

export const externalTransferService = {
  /**
   * Validate recipient (format + TriVerify on-chain existence), authorize the
   * PIN, price the transfer, check the sender can actually cover gas, and
   * persist a single-use intent. Nothing here moves funds — the client signs
   * locally and comes back to /submit.
   */
  async prepare(input: PrepareExternalTransferInput): Promise<PreparedExternalTransfer> {
    const adapter = await getChainAdapter(input.chain);

    // Legality of the chain/asset pair. ERC-20 support is registry-driven, so
    // a wrong-network/wrong-token combination is rejected here, before any
    // PIN is spent or any intent is written.
    const token = this.resolveAsset(input.chain, input.asset);

    if (!adapter.isValidAddress(input.to)) {
      fail(400, "Recipient address failed validation");
    }

    // Same gate as internal transfers: 5 wrong PINs -> 15-minute lockout.
    // Deliberately before the TriVerify lookup so a caller without the
    // PIN cannot use this endpoint to probe arbitrary addresses, while a
    // malformed request still never burns a PIN attempt.
    await pinLockoutService.assertPinAuthorized(input.userId, input.pin);

    // TriVerify (with RPC fallback): proves the address exists/is active on
    // the target chain and blocks cross-chain paste mistakes.
    await verifyAddressExists(input.to, input.chain);

    const wallet = await prisma.wallet.findUnique({
      where: { userId_chain: { userId: input.userId, chain: input.chain } },
    });
    if (!wallet) fail(400, `You have no wallet on ${input.chain}`);

    // A token transfer needs its own contract call, built here so the client
    // signs exactly what the server verified.
    let tokenPlan;
    if (token) {
      if (!adapter.buildTokenTransfer) {
        fail(501, `Token transfers are not supported on ${input.chain}`);
      }
      try {
        tokenPlan = await adapter.buildTokenTransfer(
          { fromAddress: wallet.address, toAddress: input.to, asset: input.asset, amount: input.amount },
          token,
        );
      } catch (err) {
        logger.warn({ err, chain: input.chain, asset: input.asset }, "external/prepare: token transfer build failed");
        fail(502, "Could not build the token transfer right now. Try again shortly.");
      }

      // Insufficient token balance is a user-fixable 400, checked before an
      // intent is persisted so no stale intent is left behind.
      if (!adapter.getTokenBalance) {
        fail(501, `Token balance checks are not supported on ${input.chain}`);
      }
      const available = await adapter.getTokenBalance(wallet.address, input.asset);
      if (!isAtLeast(available, input.amount, token.decimals)) {
        fail(400, `Insufficient ${token.symbol} balance. You have ${available} ${token.symbol}.`);
      }
    }

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

    // Insufficient native gas: a token transfer still has to be paid for in
    // the chain's native asset, so check the sender can cover it.
    if (adapter.canPayGas && adapter.getNativeBalance) {
      let canPay: boolean;
      let nativeBalance: string;
      try {
        [canPay, nativeBalance] = await Promise.all([
          adapter.canPayGas(wallet.address, fee),
          adapter.getNativeBalance(wallet.address),
        ]);
      } catch (err) {
        logger.warn({ err, chain: input.chain }, "external/prepare: gas balance check failed");
        fail(502, "Could not check your gas balance right now. Try again shortly.");
      }
      if (!canPay) {
        const native = nativeAssetFor(input.chain) ?? "native";
        fail(400, `Insufficient ${native} for network fees. You need about ${fee} ${native} and have ${nativeBalance}.`);
      }
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
      // `fee` is also the native gas the sender must hold on top of the
      // transfer amount; it is checked against the wallet's native balance
      // above, so the client does not need a second field for it.
      fee,
      status: "READY",
      ...(tokenPlan
        ? {
            token: {
              symbol: token!.symbol,
              address: tokenPlan.token.address,
              decimals: tokenPlan.token.decimals,
              contract: tokenPlan.to,
              callData: tokenPlan.data,
            },
          }
        : {}),
    };
  },

  /**
   * Resolves the chain/asset pair to either a native asset or a configured
   * ERC-20 token, rejecting everything else.
   */
  resolveAsset(chain: ChainName, asset: string): TokenConfig | null {
    const token = resolveToken(chain, asset);
    if (token) return token;
    const native = NATIVE_ASSETS[chain];
    if (native && asset === native) return null;
    const available = NATIVE_ASSETS[chain]
      ? [NATIVE_ASSETS[chain], ...listTokens(chain).map((t) => t.symbol)]
      : [];
    const hint = available.length > 0 ? ` Supported on ${chain}: ${available.join(", ")}.` : "";
    fail(400, `${asset} transfers are not supported on ${chain}.${hint}`);
  },

  /**
   * Consume a prepared intent: decode the client-signed transaction, verify
   * every money-moving field against the stored intent (never trust the
   * client), then create the ledger row and enqueue the broadcast.
   */
  async submit(userId: string, intentId: string, signedTx: string, idempotencyKey: string): Promise<unknown> {
    // Replay fast-path: the original submit created its row, but the response
    // was lost (mobile network timeout). Return that row unchanged — no new
    // transfer, no second broadcast. Deliberately before the single-use claim.
    const existing = await transactionService.findByIdempotencyKey(idempotencyKey, userId);
    if (existing) return { ...existing, direction: "sent", counterpartyAccountId: existing.recipientAddress };

    // Atomic single-use claim: exactly one request can flip READY -> USED.
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
      const raced = await transactionService.findByIdempotencyKey(idempotencyKey, userId);
      if (raced) return { ...raced, direction: "sent", counterpartyAccountId: raced.recipientAddress };

      const intent = await prisma.externalTransferIntent.findUnique({ where: { id: intentId } });
      if (intent?.userId !== userId) fail(404, "Transfer intent not found");
      if (intent.status === "USED") fail(409, "This transfer was already submitted");
      if (intent.expiresAt.getTime() <= Date.now()) {
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
      const verified = this.verifySignedTransaction(intent, signedTx);

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
      } catch (err) {
        // Lost a unique-constraint race on the key: another concurrent request
        // (same client retrying, or a second device) created the row first.
        if (!isUniqueConstraintViolation(err)) throw err;
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

  /**
   * Decode the signed transaction and compare it to the intent. Any mismatch
   * in recipient, amount, chain, asset, token contract or calldata fails the
   * submit without broadcasting.
   *
   * Native:  to = recipient, value = amount, data = 0x
   * ERC-20:  to = token contract, value = 0,
   *          data = transfer(recipient, amount)
   */
  /**
   * Last line of defence before funds move: checks the signed transaction
   * really is the transfer that was prepared, byte for byte.
   *
   * Synchronous by design — it only inspects an already-signed transaction and
   * makes no I/O, so there is nothing to await. Callers `await` the result,
   * which is correct for a non-promise value too.
   */
  verifySignedTransaction(
    intent: { chain: string; asset: string; amount: { toString(): string }; recipient: string },
    signedTx: string,
  ): { to: string; value: string; chainId: string; kind: "native" | "erc20" } {
    if (!isEvmChain(intent.chain)) {
      fail(400, `Signed-transaction verification is not implemented for ${intent.chain}`);
    }

    let parsed: ethers.Transaction;
    try {
      parsed = ethers.Transaction.from(signedTx);
    } catch {
      fail(400, "The signed transaction could not be decoded");
    }

    const expectedChainId = getEvmChainId(intent.chain);
    // ethers >= 6.16 types chainId as bigint.
    if (parsed.chainId !== BigInt(expectedChainId)) {
      fail(400, "The signed transaction targets a different network than the prepared transfer");
    }

    const token = resolveToken(intent.chain as ChainName, intent.asset);
    const amount = intent.amount.toString();

    if (token) {
      // A token transfer MUST be a call to the configured contract, with no
      // native value attached, whose data is exactly transfer(to, amount).
      if (parsed.to?.toLowerCase() !== token.address.toLowerCase()) {
        fail(400, "The signed transaction does not target the expected token contract");
      }
      if (parsed.value !== 0n) {
        fail(400, "A token transfer must not attach a native value");
      }
      if (!parsed.data || parsed.data === "0x") {
        fail(400, "The signed transaction is missing the token transfer call");
      }
      let decoded: { to: string; amount: bigint };
      try {
        decoded = ERC20_INTERFACE.decodeFunctionData("transfer", parsed.data) as unknown as {
          to: string;
          amount: bigint;
        };
      } catch {
        fail(400, "The signed transaction does not contain a valid token transfer");
      }
      if (decoded.to.toLowerCase() !== intent.recipient.toLowerCase()) {
        fail(400, "The signed token transfer pays a different recipient than the prepared transfer");
      }
      if (decoded.amount !== toBaseUnits(amount, token.decimals)) {
        fail(400, "The signed token transfer amount does not match the prepared transfer");
      }
      return { to: parsed.to, value: "0", chainId: parsed.chainId.toString(), kind: "erc20" };
    }

    // Native transfer: plain value movement, no contract data.
    const recipient = parsed.to;
    if (
      recipient?.toLowerCase() !== intent.recipient.toLowerCase() ||
      parsed.value !== toBaseUnits(amount, 18)
    ) {
      fail(400, "The signed transaction does not match the prepared transfer");
    }
    if (parsed.data && parsed.data !== "0x") {
      fail(400, "The signed transaction contains unexpected data");
    }
    return { to: recipient, value: parsed.value.toString(), chainId: parsed.chainId.toString(), kind: "native" };
  },
};

/** Minimal ERC-20 interface for decoding a submitted transfer. */
const ERC20_INTERFACE = new ethers.Interface([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/**
 * Decimal-string comparison with no floating point, at the token's own scale.
 * (Using 18 here would mis-scale a 6-decimal token by 10^12.)
 */
function isAtLeast(available: string, required: string, decimals: number): boolean {
  try {
    return toBaseUnits(available, decimals) >= toBaseUnits(required, decimals);
  } catch {
    return false;
  }
}
