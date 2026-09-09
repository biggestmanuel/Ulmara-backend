import type { FastifyInstance } from "fastify";
import { authController } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export async function authRoutes(app: FastifyInstance) {
  app.post("/signup", authController.signup);
  app.post("/login", authController.login);
  app.post("/verify-email", authController.verifyEmail);
  app.post("/verify-phone", authController.verifyPhone);
  app.post("/forgot-password", authController.forgotPassword);
  app.post("/set-pin", { preHandler: requireAuth }, authController.setPin);
  app.post("/verify-pin", { preHandler: requireAuth }, authController.verifyPin);
  app.post("/change-pin", { preHandler: requireAuth }, authController.changePin);
  app.get("/sessions", { preHandler: requireAuth }, authController.listSessions);
  app.delete("/sessions/:id", { preHandler: requireAuth }, authController.revokeSession);
}
