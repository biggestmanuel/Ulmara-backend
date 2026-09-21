import type { FastifyInstance } from "fastify";
import { transactionController } from "../controllers/transaction.controller.js";
import { externalTransferController } from "../controllers/externalTransfer.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export async function transactionRoutes(app: FastifyInstance) {
  app.post("/send", { preHandler: requireAuth }, transactionController.send);
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
  app.post("/external/prepare", { preHandler: requireAuth }, externalTransferController.prepare);
  app.post("/external/:id/submit", { preHandler: requireAuth }, externalTransferController.submit);
}
