import { Queue } from "bullmq";
import { redisConnection } from "./redis.connection.js";
import { QUEUE_NAMES } from "./index.js";

export const rampQueue = new Queue(QUEUE_NAMES.ramp, {
  connection: redisConnection,
});
