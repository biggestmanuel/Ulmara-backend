import net from "node:net";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Disable Node's Happy-Eyeballs dual-stack connect BEFORE any socket is
 * created.
 *
 * Why: when a host publishes both A and AAAA records, Node >= 20
 * (autoSelectFamily, on by default) races both families via
 * `internalConnectMultiple`. Any unreachable AAAA address fails the whole
 * connect with a bare `AggregateError [ETIMEDOUT]`, even though IPv4 is fine
 * — the raw socket and TLS layers succeed while the driver reports a timeout.
 *
 * This is not hypothetical: with WSL2 mirrored networking the Neon host
 * advertises an AAAA record that is advertised but not routable, and every
 * Prisma query failed with an empty-message ETIMEDOUT while the Neon CLI and
 * the Prisma CLI connected fine. Pinning the default to the single family that
 * `dns.lookup` returns first makes DB connectivity independent of whether a
 * host's IPv6 path is actually usable.
 *
 * `setDefaultAutoSelectFamily` is a process-wide default and must run before
 * the pool opens its first socket, hence it is set at module load.
 */
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: env.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
});

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("Database connected");
  } catch (err) {
    logger.error({ err }, "Failed to connect to database");
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info("Database disconnected");
}
