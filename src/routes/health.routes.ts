import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../config/database.js";
import { getRedis } from "../queues/redis.client.js";
import { transactionQueue } from "../queues/transaction.queue.js";
import { rampQueue } from "../queues/ramp.queue.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { isSentryEnabled } from "../config/sentry.js";
import { jwtRotationState } from "../config/jwt.js";
import { isEmailProviderConfigured } from "../services/email/index.js";
import { getRampProviderName, isRampProviderConfigured } from "../services/ramp/providers/index.js";
import { QUEUE_NAMES } from "../queues/index.js";
import { RPC_ENV_VAR_BY_CHAIN, rpcConfiguredFor, validateNetworkConfiguration } from "../chains/networks.js";
import type { Queue } from "bullmq";

/**
 * Liveness / readiness / operational visibility.
 *
 *  GET /health              liveness probe for an uptime monitor. Cheap, no
 *                            auth, no dependency calls, always 200 while the
 *                            process is up. This is the endpoint an external
 *                            monitor (UptimeRobot, Better Stack, Pingdom,
 *                            Kubernetes probe) should poll.
 *
 *  GET /health/ready        readiness: verifies the dependencies the API
 *                            actually needs. 503 when degraded so a load
 *                            balancer stops routing.
 *
 *  GET /internal/queues     BullMQ depth/lag per queue.
 *  GET /internal/config     non-secret runtime configuration snapshot.
 *
 * The two /internal routes are guarded by INTERNAL_API_TOKEN and 404 (not
 * 403) in production when the token is unset, so an unconfigured deployment
 * does not leak operational detail by default.
 */

const QUEUES: { name: string; queue: Queue }[] = [
  { name: QUEUE_NAMES.transactions, queue: transactionQueue },
  { name: QUEUE_NAMES.ramp, queue: rampQueue },
];

function requireInternalToken(request: FastifyRequest, reply: FastifyReply): boolean {
  // Unset token: the endpoints exist in dev but are hidden in production.
  if (!env.INTERNAL_API_TOKEN) {
    if (env.NODE_ENV === "production") {
      reply.code(404).send({ success: false, message: "Not found" });
      return false;
    }
    return true;
  }
  const header = request.headers.authorization;
  const queryToken = (request.query as { token?: string } | undefined)?.token;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : queryToken;
  if (provided !== env.INTERNAL_API_TOKEN) {
    reply.code(401).send({ success: false, message: "Unauthorized" });
    return false;
  }
  return true;
}

export interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
  /** Jobs whose earliest run time is in the past — real processing lag. */
  backlogSeconds: number | null;
}

export async function readQueueDepths(): Promise<QueueDepth[]> {
  return Promise.all(
    QUEUES.map(async ({ name, queue }) => {
      // One round trip per counter group; a Redis outage must not take the
      // whole endpoint down, so each queue degrades independently.
      try {
        const counts = await queue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
          "completed",
        );
        // `paused` is not a BullMQ JobType; a paused queue reports zero depth.
        const paused = await queue.isPaused().catch(() => false);
        const delayed = counts.delayed ?? 0;
        let backlogSeconds: number | null = null;
        if (delayed > 0) {
          // Real lag = how far past its scheduled time the oldest delayed job is.
          const first = await queue.getDelayed(0, 0);
          const earliest = first[0]?.timestamp;
          if (typeof earliest === "number") {
            backlogSeconds = Math.max(0, Math.round((Date.now() - earliest) / 1000));
          }
        }
        return {
          name,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          paused: paused ? 1 : 0,
          backlogSeconds,
        };
      } catch (err) {
        logger.error({ err, queue: name }, "Could not read queue depth");
        return {
          name,
          waiting: -1,
          active: -1,
          delayed: -1,
          failed: -1,
          completed: -1,
          paused: -1,
          backlogSeconds: null,
        };
      }
    }),
  );
}

export function registerHealthRoutes(app: FastifyInstance): void {
  const startedAt = Date.now();

  /**
   * Liveness. Deliberately dependency-free so a database blip does not get
   * the process killed by a restart loop; use /health/ready for that.
   */
  app.get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  app.get("/health/ready", async (_request, reply) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch (err) {
      checks.database = { ok: false, error: (err as Error).message };
    }

    // `SELECT 1` proves the server accepts connections and nothing more — it
    // succeeds against a COMPLETELY EMPTY database. On 2026-10-03 that made a
    // 7-hour outage invisible: every Prisma-backed route was returning 500 with
    // `relation "public.User" does not exist`, while this endpoint reported
    // `database: ok` throughout and nothing alerted.
    //
    // So also assert the schema is actually there. `_prisma_migrations` is the
    // cheapest honest signal: it only exists once `migrate deploy` has run, and a
    // zero finished count means the database is unusable.
    try {
      const rows = await prisma.$queryRaw<{ finished: bigint }[]>`
        SELECT count(*) AS finished FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
      `;
      const finished = Number(rows[0]?.finished ?? 0);
      checks.schema =
        finished > 0
          ? { ok: true }
          : { ok: false, error: "no applied migrations — run prisma migrate deploy" };
    } catch (err) {
      // A missing `_prisma_migrations` relation means the schema was never
      // deployed, or the database was emptied. Either way the app cannot serve a
      // single query, and saying so is the entire point of this check.
      checks.schema = { ok: false, error: (err as Error).message };
    }

    try {
      const pong = await getRedis().ping();
      checks.redis = { ok: pong === "PONG" };
    } catch (err) {
      checks.redis = { ok: false, error: (err as Error).message };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/internal/queues", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return reply;
    const queues = await readQueueDepths();
    return reply.send({
      success: true,
      data: { queues, timestamp: new Date().toISOString() },
    });
  });

  app.get("/internal/config", async (request, reply) => {
    if (!requireInternalToken(request, reply)) return reply;
    return reply.send({
      success: true,
      data: {
        nodeEnv: env.NODE_ENV,
        port: env.PORT,
        logLevel: env.LOG_LEVEL,
        email: {
          provider: env.EMAIL_PROVIDER,
          configured: isEmailProviderConfigured(),
          from: env.EMAIL_FROM,
          otpTtlSeconds: env.OTP_TTL_SECONDS,
        },
        ramp: { provider: getRampProviderName(), configured: isRampProviderConfigured() },
        monitoring: { sentry: isSentryEnabled(), environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV },
        jwt: jwtRotationState(),
        chains: {
          ethereumChainId: env.ETHEREUM_CHAIN_ID,
          bscChainId: env.BSC_CHAIN_ID ?? null,
          baseChainId: env.BASE_CHAIN_ID ?? null,
          polygonChainId: env.POLYGON_CHAIN_ID ?? null,
          // Which RPC endpoints are live right now, plus any configuration
          // problems worth alerting on (unknown chain id, missing RPC).
          rpcConfigured: Object.fromEntries(
            Object.keys(RPC_ENV_VAR_BY_CHAIN).map((c) => [c, rpcConfiguredFor(c as never)]),
          ),
          problems: validateNetworkConfiguration(),
        },
      },
    });
  });
}

/**
 * Periodic structured queue-depth log. Enabled with
 * QUEUE_DEPTH_LOG_INTERVAL_MS (>0); disabled with 0. Unref'd so it never
 * holds the process open during shutdown.
 */
export function startQueueDepthLogger(): NodeJS.Timeout | null {
  if (env.QUEUE_DEPTH_LOG_INTERVAL_MS <= 0) return null;
  const timer = setInterval(() => {
    void readQueueDepths().then((queues) => {
      logger.info({ event: "queue_depth", queues }, "BullMQ queue depth snapshot");
    });
  }, env.QUEUE_DEPTH_LOG_INTERVAL_MS);
  timer.unref();
  return timer;
}
