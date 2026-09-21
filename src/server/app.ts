import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { authRoutes } from "../routes/auth.routes.js";
import { accountRoutes } from "../routes/account.routes.js";
import { walletRoutes } from "../routes/wallet.routes.js";
import { transactionRoutes } from "../routes/transaction.routes.js";
import { paymentRoutes } from "../routes/payment.routes.js";
import { rampRoutes } from "../routes/ramp.routes.js";
import { contactRoutes } from "../routes/contact.routes.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { registerWebsocketHandlers } from "../websocket/socket.handler.js";
import { validationRoutes } from "../routes/validation.routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify<any, any, any, any>({
    loggerInstance: logger,
    disableRequestLogging: false,
  });
  app.setErrorHandler(errorHandler);

  // CORS is locked to an explicit origin allowlist: any origin not listed
  // gets a 403 from @fastify/cors. ALLOWED_ORIGINS is a comma-separated list
  // (frontend web builds, local Expo web). In production the variable is
  // required and must contain at least one https:// origin.
  await app.register(cors, {
    origin: parseAllowedOrigins(env.ALLOWED_ORIGINS),
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(websocket);
  await registerWebsocketHandlers(app);

  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(accountRoutes, { prefix: "/api/account" });
  await app.register(walletRoutes, { prefix: "/api/wallet" });
  await app.register(transactionRoutes, { prefix: "/api/transaction" });
  await app.register(paymentRoutes, { prefix: "/api/payment" });
  await app.register(rampRoutes, { prefix: "/api/ramp" });
  await app.register(validationRoutes, { prefix: "/api/validation" });
  await app.register(contactRoutes, { prefix: "/api/contact" });

  return app;
}

export function parseAllowedOrigins(raw: string): string[] {
  const origins = [
    ...new Set(
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ];
  if (origins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must list at least one origin");
  }
  if (env.NODE_ENV === "production" && !origins.every((origin) => origin.startsWith("https://"))) {
    throw new Error("ALLOWED_ORIGINS must contain only https:// origins in production");
  }
  return origins;
}