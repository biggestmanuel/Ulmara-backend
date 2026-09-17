import type { FastifyInstance } from "fastify";
import { paymentController } from "../controllers/payment.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export async function paymentRoutes(app: FastifyInstance) {
  app.post("/request", { preHandler: requireAuth }, paymentController.createRequest);
  app.get("/request/:id", paymentController.getRequest); // public — shared via link/QR
  app.post("/request/:id/fulfill", { preHandler: requireAuth }, paymentController.fulfillRequest);
}
