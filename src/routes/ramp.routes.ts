import type { FastifyInstance } from "fastify";
import { rampController } from "../controllers/ramp.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { createTightenedRateLimit } from "../middleware/rateLimit.middleware.js";

export function rampRoutes(app: FastifyInstance) {
  // Tighter per-user ceilings for money movement, layered on the global
  // limiter in app.ts. Keyed per user once requireAuth has run.
  const depositLimit = createTightenedRateLimit(app, { max: 5, timeWindow: "1 minute" });
  const withdrawLimit = createTightenedRateLimit(app, { max: 5, timeWindow: "1 minute" });

  app.post("/deposit", { preHandler: [requireAuth, depositLimit.preHandler] }, rampController.deposit);
  app.post("/withdraw", { preHandler: [requireAuth, withdrawLimit.preHandler] }, rampController.withdraw);
  app.get("/status/:reference", { preHandler: requireAuth }, rampController.getStatus);

  // Provider webhook. Unauthenticated by design — authenticity comes from the
  // signature over the raw body, not from a bearer token. NOT rate limited by
  // the per-user limiter because there is no user yet; the global IP limiter
  // still applies, and every delivery is signature-checked before it can do
  // anything.
  app.post("/webhook", rampController.webhook);
}
