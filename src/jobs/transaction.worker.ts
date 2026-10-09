import { Worker, type WorkerOptions } from "bullmq";
import { redisConnection } from "../queues/redis.connection.js";
import { transactionQueue } from "../queues/transaction.queue.js";
import { QUEUE_NAMES } from "../queues/index.js";
import { logger } from "../config/logger.js";
import { reportError } from "../config/sentry.js";
import { prisma } from "../config/database.js";
import { getChainAdapter } from "../chains/index.js";
import { publishUserEvent } from "../websocket/emit.js";
import { WS_EVENTS } from "../websocket/events.js";

/**
 * Transaction queue processor.
 *
 * Exports a FACTORY rather than a booted worker so the worker process
 * (src/worker/index.ts) owns the lifecycle and the API process never
 * accidentally starts consuming.
 */
/**
 * The job payload contract. Declared once and used as the `Job` type parameter
 * so `job.data` is typed here instead of being `any` (which previously forced
 * an inline cast on the very next line).
 */
interface TransactionJobData {
  transactionId: string;
  signedTx?: string;
  txHash?: string;
  checkOnly?: boolean;
}

export function createTransactionWorker(options: { connection?: WorkerOptions["connection"] } = {}): Worker {
  return new Worker<TransactionJobData>(
    QUEUE_NAMES.transactions,
    async (job) => {
      logger.info({ jobId: job.id, jobName: job.name, transactionId: job.data?.transactionId }, "Processing transaction job");
      const { transactionId, signedTx, txHash, checkOnly } = job.data;
      const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
      if (!transaction) throw new Error("Transaction not found");

      if (checkOnly && txHash) {
        const adapter = await getChainAdapter(transaction.network);
        const status = await adapter.getTransactionStatus(txHash);
        if (status === "confirmed" || status === "failed") {
          await prisma.transaction.update({
            where: { id: transactionId },
            data: { status: status === "confirmed" ? "COMPLETED" : "FAILED" },
          });
          if (status === "confirmed") {
            await prisma.receipt.upsert({ where: { transactionId }, update: {}, create: { transactionId } });
          }
          // Both parties care about the outcome, so fan out to each side.
          await notifyTransaction(transaction.senderId, transactionId, status === "confirmed" ? "COMPLETED" : "FAILED", txHash);
          if (transaction.recipientAccountId) {
            const recipient = await prisma.accountId.findUnique({
              where: { accountId: transaction.recipientAccountId },
              select: { userId: true },
            });
            if (recipient) {
              await notifyTransaction(recipient.userId, transactionId, status === "confirmed" ? "COMPLETED" : "FAILED", txHash);
            }
          }
          return { transactionId, status };
        }
        // Still in flight: re-check later. `delay` (not a sleep) so a restart
        // does not lose the pending check.
        await transactionQueue.add("check-transaction", { transactionId, txHash, checkOnly: true }, { delay: 10_000 });
        return { transactionId, status: "pending" };
      }

      if (!signedTx) {
        await prisma.transaction.update({ where: { id: transactionId }, data: { status: "FAILED" } });
        throw new Error("Signed transaction is required before broadcast");
      }

      await prisma.transaction.update({ where: { id: transactionId }, data: { status: "PROCESSING" } });
      try {
        const adapter = await getChainAdapter(transaction.network);
        if (!adapter.sendSignedTransaction) {
          throw new Error(`Signed broadcast is not implemented for ${transaction.network}`);
        }
        const { txHash: broadcastHash } = await adapter.sendSignedTransaction(signedTx);
        await prisma.transaction.update({
          where: { id: transactionId },
          data: { txHash: broadcastHash, status: "PROCESSING" },
        });
        await transactionQueue.add(
          "check-transaction",
          { transactionId, txHash: broadcastHash, checkOnly: true },
          { delay: 10_000 },
        );
        return { transactionId, txHash: broadcastHash };
      } catch (error) {
        await prisma.transaction.update({ where: { id: transactionId }, data: { status: "FAILED" } });
        await notifyTransaction(transaction.senderId, transactionId, "FAILED");
        reportError(error, "Transaction broadcast failed", { transactionId });
        throw error;
      }
    },
    {
      connection: options.connection ?? redisConnection,
      // Retry policy is declared per job (see the `add` calls above) so a
      // broadcast retry and a status-poll retry can differ.
    },
  );
}

async function notifyTransaction(
  userId: string,
  transactionId: string,
  status: string,
  txHash?: string,
): Promise<void> {
  try {
    await publishUserEvent({
      userId,
      event: WS_EVENTS.TRANSACTION_UPDATED,
      payload: { transactionId, status, txHash: txHash ?? null },
    });
  } catch (err) {
    // Real-time delivery is best-effort; it must never fail a job whose
    // on-chain effect already succeeded.
    logger.warn({ err, transactionId, userId }, "Could not publish the transaction event");
  }
}
