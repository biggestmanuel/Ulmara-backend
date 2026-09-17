import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.middleware.js";
import { contactController } from "../controllers/contact.controller.js";

export async function contactRoutes(app: FastifyInstance) {
  app.get("/", { preHandler: requireAuth }, contactController.list);
  app.post("/", { preHandler: requireAuth }, contactController.create);
  app.delete("/:id", { preHandler: requireAuth }, contactController.remove);
}
