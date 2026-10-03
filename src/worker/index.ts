import type { Worker } from "bullmq";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { initSentry, flushSentry } from "../config/sentry.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { redisConnection } from "../queues/redis.connection.js";
import { createTransactionWorker } from "../jobs/transaction.worker.js";
import { createRampWorker } from "../jobs/ramp.worker.js";
import { closeRedis } from "../queues/redis.client.js";

/**
 * Dedicated BullMQ worker process.
 *
 * Production runs the API and the workers as SEPARATE processes:
 *   npm run start          -> API only (src/server/server.ts)
 *   npm run start:worker   -> this file
 *
 * Keeping them apart means a worker crash/OOM/restart never takes the HTTP
 * surface down, the two can be scaled independently, and an API deploy does
 * not interrupt in-flight jobs.
 *
 * Graceful shutdown on SIGTERM/SIGINT:
 *   1. `worker.close()` stops fetching new jobs and WAITS for the job
 *      currently executing to finish,
 *   2. only then close Redis and the database,
 *   3. flush Sentry so a shutdown-time error is not lost.
 * Jobs that had not started stay in Redis and are picked up by the next
 * worker (BullMQ's stalled-job mechanism re-queues anything that was
 * mid-flight when the process died).
 */

const workers: Worker[] = [];
let shuttingDown = false;

function wireWorkerLogging(worker: Worker, name: string): void {
  worker.on("ready", () => logger.info({ event: "worker_ready", worker: name }, `${name} worker is ready`));
  worker.on("error", (err) => logger.error({ event: "worker_error", worker: name, err }, `${name} worker error`));
  worker.on("failed", (job, err) =>
    logger.warn(
      { event: "worker_job_failed", worker: name, jobId: job?.id, attempts: job?.attemptsMade, err },
      `${name} job failed`,
    ),
  );
  worker.on("completed", (job) => logger.info({ event: "worker_job_completed", worker: name, jobId: job.id }, `${name} job completed`));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "worker_shutdown_start", signal }, "Worker shutdown started; draining in-flight jobs");

  // Hard deadline so a stuck job cannot hold the deploy open forever.
  const drainTimeout = setTimeout(() => {
    logger.error({ event: "worker_shutdown_timeout" }, "Drain timed out; forcing exit");
    process.exit(1);
  }, 30_000);
  drainTimeout.unref();

  try {
    await Promise.all(workers.map((worker) => worker.close()));
    logger.info({ event: "worker_drained" }, "All in-flight jobs finished");
  } catch (err) {
    logger.error({ event: "worker_drain_error", err }, "Error while draining workers");
  }

  clearTimeout(drainTimeout);
  await disconnectDatabase().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  // BullMQ's connection is a separate client from the app's.
  await redisConnection.quit().catch(() => redisConnection.disconnect());
  await flushSentry();
  logger.info({ event: "worker_shutdown_complete", signal }, "Worker shutdown complete");
  process.exit(0);
}

async function start(): Promise<void> {
  initSentry();

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await connectDatabase();

    const transactionWorker = createTransactionWorker();
    const rampWorker = createRampWorker();
    workers.push(transactionWorker, rampWorker);
    wireWorkerLogging(transactionWorker, "transactions");
    wireWorkerLogging(rampWorker, "ramp");

    logger.info(
      { event: "worker_started", env: env.NODE_ENV, concurrency: { transactions: transactionWorker.concurrency, ramp: rampWorker.concurrency } },
      "Ulmara backend worker process started",
    );
  } catch (err) {
    logger.fatal({ err }, "Worker process failed to start");
    await flushSentry();
    process.exit(1);
  }
}

void start();
