import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// ---------------------------------------------------------------------------
// Stricter, per-route rate limits for security-sensitive endpoints.
//
// Layering: the global limiter (app.ts, 100 req/min per IP) still runs first
// for every request. These preHandler limiters run afterwards and add a much
// tighter ceiling on top — a route-level config.rateLimit would REPLACE the
// global limit for that route instead of stacking, so the plugin's
// createRateLimit decorator is used here instead (pure check, no response
// side effects, separate counter store per limiter instance).
//
// Separation of concerns with the PIN lockout (pinLockout.service.ts): the
// rate limit is a fast, request/IP-level throttle against spraying (429s);
// the lockout is a slower, account-level block on consecutive wrong PINs
// (401s). Neither suppresses the other — a brute-force spray hits the rate
// limit long before, and independently of, arming a lockout, and lockout
// bookkeeping for requests that do arrive is unaffected.
//
// 429 responses use the standard error envelope ({ success, message }) via
// the app-wide error handler. Messages are deliberately generic: they reveal
// neither which user/account exists nor how many attempts remain.
// ---------------------------------------------------------------------------

/** Key per client IP (used where no auth context exists, e.g. login). */
async function ipKey(request: FastifyRequest): Promise<string> {
  return request.ip;
}

/** Key per authenticated user, falling back to IP before auth runs. */
async function userOrIpKey(request: FastifyRequest): Promise<string> {
  return request.userId ?? request.ip;
}

/** 429 for these routes. Passes no details beyond "try again later". */
function rejectWith429(): never {
  // Same convention as the services: an Error carrying a statusCode, handled
  // by the app-wide error middleware into the standard error envelope.
  throw Object.assign(new Error("Too many requests. Please slow down and try again later."), {
    statusCode: 429,
  });
}

interface TightenedLimiter {
  /** Throws a 429 error when this route's budget for the window is spent. */
  preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Creates an isolated limiter (its own counter store) for one route.
 * Limits follow auth context when it exists: request.userId if requireAuth
 * has already run, otherwise the client IP.
 */
export function createTightenedRateLimit(
  app: FastifyInstance,
  options: { max: number; timeWindow: string },
): TightenedLimiter {
  const check = app.createRateLimit({
    max: options.max,
    timeWindow: options.timeWindow,
    keyGenerator: userOrIpKey,
  });

  return {
    async preHandler(request, reply) {
      const result = await check(request);
      // The raw limiter result always reports isAllowed:false for normal
      // requests (true only for allowlisted keys) — the over-budget signal
      // is isExceeded.
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", result.ttlInSeconds);
        rejectWith429();
      }
    },
  };
}

/** Same as createTightenedRateLimit but always keyed by IP (pre-auth routes). */
export function createIpRateLimit(
  app: FastifyInstance,
  options: { max: number; timeWindow: string },
): TightenedLimiter {
  const check = app.createRateLimit({
    max: options.max,
    timeWindow: options.timeWindow,
    keyGenerator: ipKey,
  });

  return {
    async preHandler(request, reply) {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        reply.header("retry-after", result.ttlInSeconds);
        rejectWith429();
      }
    },
  };
}
