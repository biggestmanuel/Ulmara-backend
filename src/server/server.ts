import { buildApp } from "./app.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { connectDatabase, disconnectDatabase } from "../config/database.js";
import "../jobs/transaction.worker.js";
import "../jobs/ramp.worker.js";

async function start() {
  try {
    await connectDatabase();

    const app = await buildApp();

    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info(`🚀 Avora backend running on port ${env.PORT} [${env.NODE_ENV}]`);

    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      await app.close();
      await disconnectDatabase();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  } catch (err) {
    logger.error({ err }, "Failed to start server");
    process.exit(1);
  }
}

start();
