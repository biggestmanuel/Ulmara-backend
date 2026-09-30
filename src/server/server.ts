import { buildApp } from "./app.js";
import { env, assertEmailProviderConfigured, assertRampProviderConfigured } from "../config/env.js";
import { logger } from "../config/logger.js";
import { initSentry, flushSentry } from "../config/sentry.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import { closeRedis } from "../queues/redis.client.js";
import { stopUserEventBridge } from "../websocket/emit.js";
import { redisConnection } from "../queues/redis.connection.js";

/**
 * API server process.
 *
 * Deliberately does NOT import the BullMQ workers. Queue processing lives in
 * src/worker/index.ts and runs as its own process, so a worker crash cannot
 * take the HTTP surface down and the two can be scaled independently.
 *
 * Shutdown order: stop accepting requests -> close the websocket bridge ->
 * close Redis/DB -> flush Sentry.
 */
async function start() {
  initSentry();

  try {
    assertEmailProviderConfigured();
    assertRampProviderConfigured();
    await connectDatabase();

    const app = await buildApp();
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`🚀 Ulmara backend API running on port ${env.PORT} [${env.NODE_ENV}]`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await app.close();
        await stopUserEventBridge();
        await closeRedis();
        await disconnectDatabase();
        await redisConnection.quit().catch(() => redisConnection.disconnect());
        await flushSentry();
      } catch (err) {
        logger.error({ err }, "Error during shutdown");
      }
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    logger.fatal({ err }, "Failed to start server");
    await flushSentry();
    process.exit(1);
  }
}

void start();
