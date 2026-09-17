import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.middleware.js";
import { validationController } from "../controllers/validation.controller.js";

export async function validationRoutes(app: FastifyInstance) {
  app.post("/address", { preHandler: requireAuth }, validationController.address);
}
