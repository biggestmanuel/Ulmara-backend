import type { FastifyInstance } from "fastify";
import { transactionController } from "../controllers/transaction.controller.js";
import { externalTransferController } from "../controllers/externalTransfer.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { createTightenedRateLimit } from "../middleware/rateLimit.middleware.js";

export async function transactionRoutes(app: FastifyInstance) {
  // Stricter per-route throttles for money-movement endpoints, layered on
  // top of the global 100 req/min per-IP limiter from app.ts (separate
  // counter store; neither consumes the other's budget). Each route gets its
  // own limiter, keyed per user once requireAuth has run, so distinct users
  // never contend with each other.
  const sendLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  const externalPrepareLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  const externalSubmitLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  app.post("/send", { preHandler: [requireAuth, sendLimit.preHandler] }, transactionController.send);
  app.post("/fee", { preHandler: requireAuth }, transactionController.estimateFee);
  app.get("/", { preHandler: requireAuth }, transactionController.list);
  app.get("/:id", { preHandler: requireAuth }, transactionController.getById);
  app.get("/:id/status", { preHandler: requireAuth }, transactionController.getStatus);
  app.post("/:id/broadcast", { preHandler: requireAuth }, transactionController.broadcast);

  // External-wallet transfers: the client signs locally; the server verifies
  // the signature against a prepared, single-use intent before broadcasting.
  // Declared before "/:id"-shaped siblings that could shadow them is not a
  // concern here (different method/segment count), but the prefix is
  // deliberately distinct from "/:id/..." for clarity.
  app.post("/external/prepare", { preHandler: [requireAuth, externalPrepareLimit.preHandler] }, externalTransferController.prepare);
  app.post("/external/:id/submit", { preHandler: [requireAuth, externalSubmitLimit.preHandler] }, externalTransferController.submit);
}
