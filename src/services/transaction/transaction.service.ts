import { prisma } from "../../config/database.js";
import { getChainAdapter, type ChainName } from "../../chains/index.js";
import { transactionQueue } from "../../queues/transaction.queue.js";
import type { SendTransactionInput } from "../../types/transaction.js";

export const transactionService = {
  async broadcast(userId: string, transactionId: string, signedTx: string) {
    const transaction = await this.getById(userId, transactionId);
    if (transaction.status !== "PENDING") {
      throw Object.assign(new Error("Transaction is no longer awaiting broadcast"), { statusCode: 409 });
    }
    await transactionQueue.add("process-transaction", { transactionId: transaction.id, signedTx });
    return transaction;
  },

  async send(input: SendTransactionInput) {
    const recipient = await prisma.accountId.findUnique({
      where: { accountId: input.recipientAccountId },
    });
    if (!recipient) {
      throw Object.assign(new Error("Recipient Account ID not found"), { statusCode: 404 });
    }
    if (recipient.userId === input.senderId) {
      throw Object.assign(new Error("Cannot send to your own Account ID"), { statusCode: 400 });
    }

    const wallet = await prisma.wallet.findUnique({
      where: { userId_chain: { userId: recipient.userId, chain: input.network as ChainName } },
    });
    if (!wallet) {
      throw Object.assign(new Error(`Recipient has no wallet on ${input.network}`), {
        statusCode: 400,
      });
    }

    // Format-only validation for now; on-chain existence check pends TriVerify integration
    const adapter = await getChainAdapter(input.network);
    if (!adapter.isValidAddress(wallet.address)) {
      throw Object.assign(new Error("Recipient address failed validation"), { statusCode: 400 });
    }

    const transaction = await prisma.transaction.create({
      data: {
        senderId: input.senderId,
        recipientAccountId: input.recipientAccountId,
        asset: input.asset,
        amount: input.amount,
        network: input.network as ChainName,
        status: "PENDING",
      },
    });

    return transaction;
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
            ? item.recipientAccountId
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
        ? transaction.recipientAccountId
        : transaction.sender.accountId?.accountId ?? "Unknown",
    };
  },

  async getStatus(userId: string, id: string) {
    const transaction = await this.getById(userId, id);
    return { id: transaction.id, status: transaction.status, txHash: transaction.txHash };
  },
};
