import type { FastifyInstance } from "fastify";
import { authController } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

import {
  createIpRateLimit,
  createTightenedRateLimit,
} from "../middleware/rateLimit.middleware.js";

export function authRoutes(app: FastifyInstance) {
  // Stricter per-route throttles for security-sensitive endpoints, layered on
  // top of the global 100 req/min per-IP limiter from app.ts. These use
  // separate counter stores, so neither consumes the other's budget.
  //   - /login: unauthenticated -> per-IP (throttles credential stuffing).
  //   - /verify-email, /verify-phone, /resend-code: keyed by userId once
  //     requireAuth has run. These sit in front of the OTP flow, so they cap
  //     how fast an attacker can burn codes; the store's own wrong-attempt
  //     budget (OTP_MAX_ATTEMPTS) is the second layer.
  //   - /verify-pin: per-user once requireAuth has run. This is a fast,
  //     request-level throttle and is independent of the account-level PIN
  //     lockout (5 wrong attempts -> 15 min), which continues to apply.
  const loginLimit = createIpRateLimit(app, { max: 10, timeWindow: "1 minute" });
  const signupLimit = createIpRateLimit(app, { max: 5, timeWindow: "1 minute" });
  const verifyEmailLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  const verifyPhoneLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  // Resend triggers an outbound email, so it is the tightest: 3/min per user.
  const resendLimit = createTightenedRateLimit(app, { max: 3, timeWindow: "1 minute" });
  const forgotPasswordLimit = createIpRateLimit(app, { max: 5, timeWindow: "1 minute" });
  const verifyPinLimit = createTightenedRateLimit(app, { max: 10, timeWindow: "1 minute" });
  const changePinLimit = createTightenedRateLimit(app, { max: 5, timeWindow: "1 minute" });
  const sessionListLimit = createTightenedRateLimit(app, { max: 20, timeWindow: "1 minute" });

  app.post("/signup", { preHandler: signupLimit.preHandler }, authController.signup);
  app.post("/login", { preHandler: loginLimit.preHandler }, authController.login);
  // Verification endpoints are authenticated: the caller proves which account
  // they are completing, which is what makes a per-user budget meaningful.
  app.post("/verify-email", { preHandler: [requireAuth, verifyEmailLimit.preHandler] }, authController.verifyEmail);
  app.post("/verify-phone", { preHandler: [requireAuth, verifyPhoneLimit.preHandler] }, authController.verifyPhone);
  app.post("/resend-code", { preHandler: [requireAuth, resendLimit.preHandler] }, authController.resendCode);
  app.post("/forgot-password", { preHandler: forgotPasswordLimit.preHandler }, authController.forgotPassword);
  app.post("/set-pin", { preHandler: requireAuth }, authController.setPin);
  app.post("/verify-pin", { preHandler: [requireAuth, verifyPinLimit.preHandler] }, authController.verifyPin);
  app.post("/change-pin", { preHandler: [requireAuth, changePinLimit.preHandler] }, authController.changePin);
  app.get("/sessions", { preHandler: [requireAuth, sessionListLimit.preHandler] }, authController.listSessions);
  app.delete("/sessions/:id", { preHandler: requireAuth }, authController.revokeSession);
  // Permanent account deletion — must come after /sessions routes.
  app.delete("/me", { preHandler: requireAuth }, authController.deleteAccount);
}
