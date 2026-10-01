import type { FastifyInstance } from "fastify";
import { walletController } from "../controllers/wallet.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export function walletRoutes(app: FastifyInstance) {
  app.get("/balances", { preHandler: requireAuth }, walletController.getBalances);
  app.get("/addresses", { preHandler: requireAuth }, walletController.getAddresses);
  app.post("/resolve/:accountId", { preHandler: requireAuth }, walletController.resolveAccountId);
  app.post("/register", { preHandler: requireAuth }, walletController.registerWallets);
  // ERC-20 metadata for a chain, so the client can offer only assets that are
  // actually configured on the network it is pointed at.
  app.get("/tokens/:chain", { preHandler: requireAuth }, walletController.listTokens);
  // B5/C5. Registered as a distinct path rather than folded into /balances so
  // the existing balances response is untouched.
  app.get("/token-balances", { preHandler: requireAuth }, walletController.tokenBalances);
}
