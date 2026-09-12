import { Worker } from "bullmq";
import { redisConnection } from "../queues/redis.connection.js";
import { logger } from "../config/logger.js";
import { prisma } from "../config/database.js";

// TODO: poll Bachs for deposit/withdrawal status, update RampTransaction row
export const rampWorker = new Worker(
  "ramp",
  async (job) => {
    logger.info({ jobId: job.id }, "Processing ramp job");
    const { rampTransactionId } = job.data as { rampTransactionId: string };
    await prisma.rampTransaction.update({
      where: { id: rampTransactionId },
      data: { status: "FAILED" },
    });
    return { rampTransactionId, status: "FAILED", reason: "Ramp provider integration is not configured" };
  },
  { connection: redisConnection }
);
