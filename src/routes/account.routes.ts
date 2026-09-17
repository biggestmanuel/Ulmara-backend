import type { FastifyInstance } from "fastify";
import { accountController } from "../controllers/account.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export async function accountRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: requireAuth }, accountController.me);
  app.post("/create-account-id", { preHandler: requireAuth }, accountController.createAccountId);
  app.get("/resolve/:accountId", { preHandler: requireAuth }, accountController.resolveForTransfer);
  app.get("/:accountId", accountController.getByAccountId); // public lookup, e.g. Send flow
  app.patch("/settings", { preHandler: requireAuth }, accountController.updateSettings);
}
