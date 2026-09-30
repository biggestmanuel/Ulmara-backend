import type { FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database.js";
import { verifySessionToken } from "../config/jwt.js";
import { logger } from "../config/logger.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.code(401).send({ success: false, message: "Unauthorized" });
  }

  const token = authHeader.slice(7);
  const verified = verifySessionToken(token);
  if (!verified.ok) {
    if (verified.reason === "expired") {
      return reply.code(401).send({ success: false, message: "Session expired" });
    }
    return reply.code(401).send({ success: false, message: "Invalid token" });
  }

  // A cryptographically valid token is not enough: the session row is the
  // source of truth, so a revoked or logged-out token stops working
  // immediately and a token signed by a retired rotation key still has to
  // belong to a live session.
  const session = await prisma.session.findUnique({ where: { token } });
  if (!session || session.expiresAt < new Date()) {
    return reply.code(401).send({ success: false, message: "Session expired" });
  }
  // The subject must still match the session's owner: a token whose claims
  // were tampered with (or minted for another user) cannot borrow this
  // session row.
  if (session.userId !== verified.claims.sub) {
    logger.warn(
      { event: "auth_subject_mismatch", sessionUserId: session.userId },
      "Rejected a token whose subject does not match its session",
    );
    return reply.code(401).send({ success: false, message: "Invalid token" });
  }

  request.userId = verified.claims.sub;
}
