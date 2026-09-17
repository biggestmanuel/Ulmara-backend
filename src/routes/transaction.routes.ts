import type { FastifyInstance } from "fastify";
import { transactionController } from "../controllers/transaction.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export async function transactionRoutes(app: FastifyInstance) {
  app.post("/send", { preHandler: requireAuth }, transactionController.send);
  app.post("/fee", { preHandler: requireAuth }, transactionController.estimateFee);
  app.get("/", { preHandler: requireAuth }, transactionController.list);
  app.get("/:id", { preHandler: requireAuth }, transactionController.getById);
  app.get("/:id/status", { preHandler: requireAuth }, transactionController.getStatus);
  app.post("/:id/broadcast", { preHandler: requireAuth }, transactionController.broadcast);
}
