import { Worker, type Job, type WorkerOptions } from "bullmq";
import { redisConnection } from "../queues/redis.connection.js";
import { QUEUE_NAMES } from "../queues/index.js";
import { logger } from "../config/logger.js";
import { prisma } from "../config/database.js";
import { rampService } from "../services/ramp/ramp.service.js";
import { isRampProviderConfigured } from "../services/ramp/providers/index.js";
import { publishUserEvent } from "../websocket/emit.js";
import { WS_EVENTS } from "../websocket/events.js";

/**
 * Ramp queue processor.
 *
 * Providers own ramp state and push it by webhook; this job is the
 * RECONCILIATION backstop. Bitnob documents that webhooks can be missed and
 * explicitly recommends polling, and Yellow Card custody events have no retry
 * at all, so a purely webhook-driven flow would strand transactions.
 */
export function createRampWorker(options: { connection?: WorkerOptions["connection"] } = {}): Worker {
  return createWorkerCore(options.connection ?? redisConnection);
}

function createWorkerCore(connection: WorkerOptions["connection"]): Worker {
  return new Worker(
    QUEUE_NAMES.ramp,
    async (job: Job) => {
      logger.info({ jobId: job.id, jobName: job.name }, "Processing ramp job");
      const { rampTransactionId, reference } = job.data as { rampTransactionId?: string; reference?: string };
      if (!rampTransactionId && !reference) {
        throw new Error("A ramp job requires rampTransactionId or reference");
      }

      if (!isRampProviderConfigured()) {
        logger.error(
          { event: "ramp_worker_unconfigured", rampTransactionId },
          "Ramp provider is not configured; leaving the transaction untouched for retry",
        );
        // Retryable: the operator may add credentials, and the row is left
        // pending rather than being failed by a config gap.
        throw new Error("Ramp provider is not configured");
      }

      const rampTx = await prisma.rampTransaction.findUnique({
        where: rampTransactionId ? { id: rampTransactionId } : { reference: reference! },
      });
      if (!rampTx) {
        logger.warn({ event: "ramp_worker_missing_row", rampTransactionId, reference }, "Ramp transaction no longer exists");
        return { status: "DELETED" };
      }

      const result = await rampService.reconcile(rampTx.reference);
      if (result.applied) {
        await publishUserEvent({
          userId: rampTx.userId,
          event: WS_EVENTS.RAMP_UPDATED,
          payload: { reference: rampTx.reference, status: result.status, type: rampTx.type },
        }).catch((err) => logger.warn({ err, reference: rampTx.reference }, "Could not publish the ramp event"));
      }
      return { reference: rampTx.reference, status: result.status, applied: result.applied };
    },
    {
      connection,
      // Retry policy is per job (see ramp.service.ts, which enqueues with
      // 5 attempts and exponential backoff).
    },
  );
}
