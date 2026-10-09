import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * Proves job processing survives the API/worker split:
 *   phase 1 (API only, no worker)  -> the job must stay WAITING
 *   phase 2 (worker running)       -> the job must be picked up and FAIL
 *                                     (the transaction id does not exist, so
 *                                     the processor throws) proving it was
 *                                     actually executed by the worker.
 */
const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const phase = process.argv[2];

const conn = new Redis(url, { maxRetriesPerRequest: null });
const q = new Queue("transactions", { connection: conn });

if (phase === "enqueue") {
  const j = await q.add("process-transaction", { transactionId: "e2e-worker-separation-probe" }, { attempts: 1 });
  console.log(`ENQUEUED jobId=${j.id}`);
  const c = await q.getJobCounts("waiting", "active", "failed", "completed");
  console.log(`COUNTS ${JSON.stringify(c)}`);
  console.log(`JOB_ID=${j.id}`);
} else {
  const jobId = process.argv[3];
  const job = await q.getJob(jobId);
  if (!job) {
    console.log("JOB_MISSING");
  } else {
    console.log(`JOB_STATE ${job.name} state=${await job.getState()} attemptsMade=${job.attemptsMade}`);
    const failed = await job.getFailedReason();
    console.log(`FAILED_REASON ${String(failed).split("\n")[0].slice(0, 90)}`);
  }
  const c = await q.getJobCounts("waiting", "active", "failed", "completed");
  console.log(`COUNTS ${JSON.stringify(c)}`);
  await q.obliterate({ force: true }).catch(() => {});
}

await q.close();
await conn.quit();
