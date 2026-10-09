import { prisma } from "../../config/database.js";
import { getChainAdapter, type ChainName } from "../../chains/index.js";
import { transactionQueue } from "../../queues/transaction.queue.js";
import type { SendTransactionInput } from "../../types/transaction.js";
import { verifyAddressExists } from "../../blockchain/triverify.js";
import { pinLockoutService } from "../auth/pinLockout.service.js";
import { isUniqueConstraintViolation } from "../../utils/prismaError.js";

// "1.50" and "1.5" are the same transfer; Decimal string forms can differ by
// trailing zeros while a retry resends the user's original input.
function normalizeAmount(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes(".") ? trimmed.replace(/0+$/, "").replace(/\.$/, "") : trimmed;
}

/**
 * Decorate a row the create path just produced (fresh or replayed) with the same
 * two derived fields `list` and `getById` already return.
 *
 * Found by a frontend contract audit: `POST /api/transaction/send` answered with
 * the bare Prisma row, while `GET /api/transaction/:id` and
 * `GET /api/transaction` both added `direction` and `counterpartyAccountId`. The
 * client therefore needed a `?? 'sent'` fallback in `normalizeTransaction` — which
 * happened to produce the right answer, because a row this endpoint returns is by
 * definition outgoing from the caller. But it was right by luck rather than by
 * contract, and the fallback is the kind of thing that keeps working after the
 * thing it was compensating for stops being true.
 *
 * Both values are knowable with no extra query: the sender IS this caller, and
 * the recipient was resolved before the row was written — an Account ID for an
 * internal transfer, a raw address for an external one, exactly as `list` and
 * `getById` choose.
 *
 * Applied to all five return points of the create path — fast-path replay,
 * post-resolution replay, the in-transaction race fold, the create itself, and
 * the unique-constraint catch — because they must not disagree. A replay of the
 * same idempotency key has to answer with the same shape as the original create,
 * or a retry would change the response contract under the caller.
 *
 * Module-level rather than a method on the service object: the service is an
 * object literal, which cannot hold a generic or a `private` method, and this
 * needs both to preserve the row's own type in the return.
 */
function describeCreated<T extends { recipientAccountId: string | null; recipientAddress: string | null }>(
  row: T,
): T & { direction: "sent"; counterpartyAccountId: string } {
  return {
    ...row,
    direction: "sent" as const,
    // Same precedence as list/getById: the Account ID when there is one, the raw
    // address otherwise, and a visible placeholder rather than a falsy empty
    // string if a row somehow has neither.
    counterpartyAccountId: row.recipientAccountId ?? row.recipientAddress ?? "Unknown",
  };
}

export const transactionService = {
  async estimateFee(input: { senderId: string; recipientAddress: string; asset: string; amount: string; network: ChainName }) {
    const senderWallet = await prisma.wallet.findUnique({
      where: { userId_chain: { userId: input.senderId, chain: input.network } },
    });
    if (!senderWallet) throw Object.assign(new Error(`Sender has no wallet on ${input.network}`), { statusCode: 400 });
    const adapter = await getChainAdapter(input.network);
    if (!adapter.isValidAddress(input.recipientAddress)) throw Object.assign(new Error("Recipient address failed validation"), { statusCode: 400 });
    return { network: input.network, asset: input.asset, fee: await adapter.estimateFee({
      fromAddress: senderWallet.address,
      toAddress: input.recipientAddress,
      asset: input.asset,
      amount: input.amount,
    }) };
  },

  async broadcast(userId: string, transactionId: string, signedTx: string) {
    const transaction = await this.getById(userId, transactionId);
    if (transaction.status !== "PENDING") {
      // A retry after a lost response lands here: the first request already
      // claimed PENDING -> PROCESSING, so returning the row replays the
      // original outcome instead of enqueueing the same signed tx twice.
      if (transaction.status === "PROCESSING") return transaction;
      throw Object.assign(new Error("Transaction is no longer awaiting broadcast"), { statusCode: 409 });
    }
    // Atomic claim so two concurrent broadcasts of the same transaction (the
    // send request retrying through both the send and broadcast paths) can
    // never both enqueue the signed transaction.
    const claimed = await prisma.transaction.updateMany({
      where: { id: transaction.id, senderId: userId, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claimed.count !== 1) {
      // Another request claimed it between the read and the write.
      return { ...transaction, status: "PROCESSING" };
    }
    try {
      await transactionQueue.add("process-transaction", { transactionId: transaction.id, signedTx });
    } catch (err) {
      // Release the claim so a retry can broadcast instead of stranding the
      // row in PROCESSING with no queued job behind it.
      await prisma.transaction.updateMany({
        where: { id: transaction.id, status: "PROCESSING", txHash: null },
        data: { status: "PENDING" },
      }).catch(() => undefined);
      throw err;
    }
    return { ...transaction, status: "PROCESSING" };
  },

  async send(input: SendTransactionInput) {
    // Transfer authorization: the PIN is checked against the server-side hash
    // before anything else runs, so a wrong or missing PIN can never create a
    // transaction, resolve a recipient, or burn fees. Failures count toward
    // the per-user lockout (5 wrong attempts -> 15 minute lockout).
    if (!input.pin) {
      throw Object.assign(new Error("A 6-digit PIN is required to authorize this transfer"), { statusCode: 400 });
    }
    await pinLockoutService.assertPinAuthorized(input.senderId, input.pin);

    // Replay fast-path: a retry after a lost response (mobile network
    // timeout-and-retry) replays the original row instead of re-validating
    // and creating a second transfer. Deliberately before TriVerify so a
    // replay survives transient validator downtime. A key that describes a
    // different transfer than its row is rejected after recipient resolution
    // below — the authoritative params check — so a client bug cannot masquerade
    // as a retry here.
    const fastPath = await this.findByIdempotencyKey(input.idempotencyKey, input.senderId);
    if (fastPath && this.matchesIntent(fastPath, input)) return describeCreated(fastPath);

    const recipientAccountId = input.recipientAccountId;
    let recipientAddress = input.recipientAddress;
    if (recipientAccountId) {
      const recipient = await prisma.accountId.findUnique({ where: { accountId: recipientAccountId } });
      if (!recipient) throw Object.assign(new Error("Recipient Account ID not found"), { statusCode: 404 });
      if (recipient.userId === input.senderId) throw Object.assign(new Error("Cannot send to your own Account ID"), { statusCode: 400 });
      const wallet = await prisma.wallet.findUnique({
        where: { userId_chain: { userId: recipient.userId, chain: input.network } },
      });
      if (!wallet) throw Object.assign(new Error(`Recipient has no wallet on ${input.network}`), { statusCode: 400 });
      recipientAddress = wallet.address;
    }

    const adapter = await getChainAdapter(input.network);
    if (!recipientAddress || !adapter.isValidAddress(recipientAddress)) {
      throw Object.assign(new Error("Recipient address failed validation"), { statusCode: 400 });
    }
    await verifyAddressExists(recipientAddress, input.network);

    // Now that the recipient is resolved, a stored key that describes a
    // different transfer is a client bug (key reuse across attempts), not a
    // retry — silently returning the old row would mislead the user.
    const reused = await this.findByIdempotencyKey(input.idempotencyKey, input.senderId);
    if (reused) {
      if (!this.matchesIntent(reused, { ...input, recipientAddress })) {
        throw Object.assign(new Error("This idempotency key was already used for a different transfer"), { statusCode: 409 });
      }
      return describeCreated(reused);
    }

    // Interactive transaction: the duplicate re-check and the create are
    // serialized against every other send, so a rapid double-tap (two
    // requests racing with the same key) produces exactly one transaction —
    // the loser of the race reads the winner's row and replays it.
    try {
      return await prisma.$transaction(async (tx) => {
        const raced = await this.findByIdempotencyKey(input.idempotencyKey, input.senderId, tx);
        if (raced) return describeCreated(raced);

        // SELECT ... FOR UPDATE on the sender's wallet row: two DISTINCT
        // legitimate transfers submitted in quick succession are serialized
        // here, so a balance check performed inside this lock can never be
        // invalidated by a concurrent transfer from the same account.
        await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${input.senderId} AND chain = ${input.network}::"Chain" FOR UPDATE`;

        return describeCreated(
          await tx.transaction.create({
            data: {
              senderId: input.senderId,
              recipientAccountId,
              recipientAddress,
              asset: input.asset,
              amount: input.amount,
              network: input.network,
              status: "PENDING",
              idempotencyKey: input.idempotencyKey,
            },
          }),
        );
      });
    } catch (err) {
      // Lost a unique-constraint race on the key against a request whose
      // lookup ran before the winner committed (e.g. a cross-user collision:
      // another user's row is invisible to this user's replay lookups).
      // Fold to the original row when the params match; surface a conflict
      // when they do not.
      if (!isUniqueConstraintViolation(err)) throw err;
      const winner = await this.findByIdempotencyKey(input.idempotencyKey, input.senderId);
      if (!winner || !this.matchesIntent(winner, { ...input, recipientAddress })) {
        throw Object.assign(new Error("This idempotency key was already used for a different transfer"), { statusCode: 409 });
      }
      return describeCreated(winner);
    }
  },

  // Does a stored transaction match what the client says it is retrying?
  // Network/asset/amount/recipient must all line up; a mismatch means the
  // key was reused across distinct attempts, which is a client bug.
  // `candidate.recipientAddress` is the resolved address when known.
  matchesIntent(stored: { network: string; asset: string; amount: { toString(): string }; recipientAddress: string | null }, candidate: SendTransactionInput & { recipientAddress?: string }): boolean {
    return (
      stored.network === candidate.network &&
      stored.asset === candidate.asset &&
      normalizeAmount(stored.amount.toString()) === normalizeAmount(candidate.amount) &&
      (candidate.recipientAddress
        ? stored.recipientAddress?.toLowerCase() === candidate.recipientAddress.toLowerCase()
        : true)
    );
  },

  // Replay lookup scoped to the key's owner: another user's key can never
  // serve (or leak) their transaction. `tx` targets the interactive
  // transaction's client when called inside prisma.$transaction.
  async findByIdempotencyKey(idempotencyKey: string, senderId: string, tx: Pick<typeof prisma, "transaction"> = prisma) {
    const existing = await tx.transaction.findUnique({ where: { idempotencyKey } });
    if (existing?.senderId !== senderId) return null;
    return existing;
  },

  async list(userId: string, page = 1, limit = 20) {
    const account = await prisma.accountId.findUnique({ where: { userId } });
    const where = {
      OR: [
        { senderId: userId },
        ...(account ? [{ recipientAccountId: account.accountId }] : []),
      ],
    };
    const [items, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: { sender: { select: { accountId: { select: { accountId: true } } } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);
    return {
      items: items.map((item) => {
        const sent = item.senderId === userId;
        return {
          ...item,
          direction: sent ? "sent" : "received",
          counterpartyAccountId: sent
            ? item.recipientAccountId ?? item.recipientAddress
            : item.sender.accountId?.accountId ?? "Unknown",
        };
      }),
      page,
      limit,
      total,
    };
  },

  async getById(userId: string, id: string) {
    const account = await prisma.accountId.findUnique({ where: { userId } });
    const transaction = await prisma.transaction.findFirst({
      where: {
        id,
        OR: [
          { senderId: userId },
          ...(account ? [{ recipientAccountId: account.accountId }] : []),
        ],
      },
      include: { sender: { select: { accountId: { select: { accountId: true } } } } },
    });
    if (!transaction) throw Object.assign(new Error("Transaction not found"), { statusCode: 404 });
    const sent = transaction.senderId === userId;
    return {
      ...transaction,
      direction: sent ? "sent" : "received",
      counterpartyAccountId: sent
        ? transaction.recipientAccountId ?? transaction.recipientAddress
        : transaction.sender.accountId?.accountId ?? "Unknown",
    };
  },

  async getStatus(userId: string, id: string) {
    const transaction = await this.getById(userId, id);
    return { id: transaction.id, status: transaction.status, txHash: transaction.txHash };
  },
};
