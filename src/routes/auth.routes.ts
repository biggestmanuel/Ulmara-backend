import type { FastifyInstance } from "fastify";
import { authController } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

import {
  createIpRateLimit,
  createTightenedRateLimit,
} from "../middleware/rateLimit.middleware.js";

export async function authRoutes(app: FastifyInstance) {
  // Stricter per-route throttles for security-sensitive endpoints, layered on
  // top of the global 100 req/min per-IP limiter from app.ts. These use
  // separate counter stores, so neither consumes the other's budget.
  //   - /login: unauthenticated -> per-IP (throttles credential stuffing).
  //   - /verify-pin: per-user once requireAuth has run. This is a fast,
  //     request-level throttle and is independent of the account-level PIN
  //     lockout (5 wrong attempts -> 15 min), which continues to apply.
  const loginLimit = createIpRateLimit(app, { max: 10, timeWindow: "1 minute" });
  const verifyPinLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  app.post("/signup", authController.signup);
  app.post("/login", { preHandler: loginLimit.preHandler }, authController.login);
  app.post("/verify-email", authController.verifyEmail);
  app.post("/verify-phone", authController.verifyPhone);
  app.post("/resend-code", authController.resendCode);
  app.post("/forgot-password", authController.forgotPassword);
  app.post("/set-pin", { preHandler: requireAuth }, authController.setPin);
  app.post("/verify-pin", { preHandler: [requireAuth, verifyPinLimit.preHandler] }, authController.verifyPin);
  app.post("/change-pin", { preHandler: requireAuth }, authController.changePin);
  app.get("/sessions", { preHandler: requireAuth }, authController.listSessions);
  app.delete("/sessions/:id", { preHandler: requireAuth }, authController.revokeSession);
  // Permanent account deletion — must come after /sessions routes.
  app.delete("/me", { preHandler: requireAuth }, authController.deleteAccount);
}
