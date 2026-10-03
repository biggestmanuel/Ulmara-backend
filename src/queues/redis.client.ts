import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

/**
 * Shared application Redis client (BullMQ keeps its own connection in
 * redis.connection.ts, which requires different retry semantics).
 *
 * Lazily constructed so importing a module that happens to use Redis does not
 * open a socket at import time — this is what makes the OTP store unit-testable
 * without a live server.
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(env.REDIS_URL, {
    // The OTP flow must fail fast on a broken Redis rather than hanging a
    // user's request; BullMQ's own client is configured separately.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
  client.on("error", (err: Error) => {
    logger.error({ err: err.message }, "Redis client error");
  });
  return client;
}

/** Test seam / shutdown hook. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const current = client;
  client = null;
  await current.quit().catch(() => current.disconnect());
}
