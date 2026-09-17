import { Worker } from "bullmq";
import { redisConnection } from "../queues/redis.connection.js";
import { transactionQueue } from "../queues/transaction.queue.js";
import { logger } from "../config/logger.js";
import { prisma } from "../config/database.js";
import { getChainAdapter, type ChainName } from "../chains/index.js";

export const transactionWorker = new Worker(
  "transactions",
  async (job) => {
    logger.info({ jobId: job.id }, "Processing transaction job");
    const { transactionId, signedTx, txHash, checkOnly } = job.data as { transactionId: string; signedTx?: string; txHash?: string; checkOnly?: boolean };
    const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction) throw new Error("Transaction not found");
    if (checkOnly && txHash) {
      const adapter = await getChainAdapter(transaction.network as ChainName);
      const status = await adapter.getTransactionStatus(txHash);
      if (status === "confirmed" || status === "failed") {
        await prisma.transaction.update({
          where: { id: transactionId },
          data: { status: status === "confirmed" ? "COMPLETED" : "FAILED" },
        });
        if (status === "confirmed") {
          await prisma.receipt.upsert({
            where: { transactionId },
            update: {},
            create: { transactionId },
          });
        }
        return { transactionId, status };
      }
      await transactionQueue.add("check-transaction", { transactionId, txHash, checkOnly: true }, { delay: 10_000 });
      return { transactionId, status: "pending" };
    }
    if (!signedTx) {
      await prisma.transaction.update({ where: { id: transactionId }, data: { status: "FAILED" } });
      throw new Error("Signed transaction is required before broadcast");
    }

    await prisma.transaction.update({ where: { id: transactionId }, data: { status: "PROCESSING" } });
    try {
      const adapter = await getChainAdapter(transaction.network as ChainName);
      if (!adapter.sendSignedTransaction) throw new Error(`Signed broadcast is not implemented for ${transaction.network}`);
      const { txHash } = await adapter.sendSignedTransaction(signedTx);
      await prisma.transaction.update({ where: { id: transactionId }, data: { txHash, status: "PROCESSING" } });
      await transactionQueue.add("check-transaction", { transactionId, txHash, checkOnly: true }, { delay: 10_000 });
      return { transactionId, txHash };
    } catch (error) {
      await prisma.transaction.update({ where: { id: transactionId }, data: { status: "FAILED" } });
      throw error;
    }
  },
  { connection: redisConnection }
);
