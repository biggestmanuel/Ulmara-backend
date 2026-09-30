import { Queue } from "bullmq";
import { redisConnection } from "./redis.connection.js";
import { QUEUE_NAMES } from "./index.js";

export const transactionQueue = new Queue(QUEUE_NAMES.transactions, {
  connection: redisConnection,
});
