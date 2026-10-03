import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { env, assertEmailProviderConfigured, assertRampProviderConfigured } from "../config/env.js";
import { logger } from "../config/logger.js";
import { authRoutes } from "../routes/auth.routes.js";
import { accountRoutes } from "../routes/account.routes.js";
import { walletRoutes } from "../routes/wallet.routes.js";
import { transactionRoutes } from "../routes/transaction.routes.js";
import { paymentRoutes } from "../routes/payment.routes.js";
import { rampRoutes } from "../routes/ramp.routes.js";
import { contactRoutes } from "../routes/contact.routes.js";
import { errorHandler } from "../middleware/error.middleware.js";
import { registerWebsocketHandlers } from "../websocket/socket.handler.js";
import { startUserEventBridge } from "../websocket/emit.js";
import { validationRoutes } from "../routes/validation.routes.js";
import { registerHealthRoutes, startQueueDepthLogger } from "../routes/health.routes.js";
import { registerApiDocs } from "../utils/openapiRoutes.js";
import { attachRouteCapture, capturedRoutes, shouldServeApiDocs, startRouteCapture } from "../utils/routeInventory.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Verbatim request bytes; required for provider webhook signature checks. */
    rawBody?: Buffer;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  // Fail fast and loudly: a production deployment with the email provider
  // selected but uncredentialed would otherwise fail on a user's first tap.
  assertEmailProviderConfigured();
  assertRampProviderConfigured();

  // The generics are stated explicitly rather than left to inference: passing
  // pino's `Logger` as `loggerInstance` makes TypeScript infer the instance's
  // logger parameter as pino's own `Logger`, which is then NOT assignable to
  // the plain `FastifyInstance` that every route module declares as its
  // parameter type. Pinning the 4th parameter to `FastifyBaseLogger` makes the
  // two identical. This replaces four `any` generics that previously hid the
  // whole route-registration surface from type checking.
  const app = Fastify<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    FastifyBaseLogger
  >({
    loggerInstance: logger,
    // Determines what `request.ip` returns, which is the key every rate limiter
    // uses. Left false, a proxied deployment gives all users one shared budget.
    trustProxy: resolveTrustProxy(env.TRUSTED_PROXIES, env.TRUSTED_PROXY_COUNT),
    // Fastify parses JSON before our handlers run, which destroys the exact
    // bytes a webhook signature is computed over. Parsing is re-enabled per
    // route in the onRequest hook below, except for the webhook.
    bodyLimit: 1_048_576,
  });
  app.setErrorHandler(errorHandler);

  // B2: an empty body with `Content-Type: application/json` is accepted as no
  // body. axios sets that header on EVERY request, including the ones that send
  // no body at all (a POST with no payload, a DELETE), and Fastify's default
  // parser rejects it before any handler runs:
  //
  //   "Body cannot be empty when content-type is set to 'application/json'"
  //
  // which is a 400 on a route that legitimately takes no input — it broke
  // POST /api/account/create-account-id and DELETE /api/auth/me. Fixed once
  // here rather than per route, so every current and future no-body route
  // benefits.
  //
  // Only a body of zero length is treated as absent. A malformed or non-empty
  // body is still parsed and still fails normally, and a route that REQUIRES
  // fields still 400s on the missing keys when its schema runs against `{}`.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (typeof body !== "string" || body.trim().length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      // Malformed JSON is a client error and must stay one, rather than
      // becoming a 500 from a throw inside the parser.
      const err = new Error("Body is not valid JSON") as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // Start recording every route registration BEFORE any plugin is registered,
  // so the OpenAPI document is built from the same table the server dispatches
  // on rather than a list maintained alongside it.
  startRouteCapture();
  attachRouteCapture(app);

  // Keep the raw body for signature-verified routes only. Everything else
  // gets Fastify's normal JSON parsing.
  const RAW_BODY_PATHS = new Set(["/api/ramp/webhook"]);
  app.addHook("preParsing", async (request) => {
    if (!RAW_BODY_PATHS.has(request.url.split("?")[0])) return;
    const chunks: Buffer[] = [];
    for await (const chunk of request.body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    request.rawBody = Buffer.concat(chunks);
  });

  // CORS is locked to an explicit origin allowlist: any origin not listed
  // gets a 403 from @fastify/cors. ALLOWED_ORIGINS is a comma-separated list
  // (frontend web builds, local Expo web). In production the variable is
  // required and must contain at least one https:// origin.
  await app.register(cors, {
    origin: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    // B4/C4: PATCH was added to the contacts API, and @fastify/cors answers a
    // preflight with its DEFAULT method list unless one is given. The default
    // does not include PATCH, so a browser preflight for a contact rename was
    // rejected before the request left the page — the route would have existed
    // and still have been unreachable from the app. Listed explicitly rather
    // than left implicit so the next added verb cannot be forgotten here.
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(websocket);
  registerWebsocketHandlers(app);
  // Workers are a separate process (src/worker/index.ts); this bridge is what
  // carries their user-scoped events to this process's sockets.
  await startUserEventBridge();

  registerHealthRoutes(app);
  startQueueDepthLogger();

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(accountRoutes, { prefix: "/api/account" });
  await app.register(walletRoutes, { prefix: "/api/wallet" });
  await app.register(transactionRoutes, { prefix: "/api/transaction" });
  await app.register(paymentRoutes, { prefix: "/api/payment" });
  await app.register(rampRoutes, { prefix: "/api/ramp" });
  await app.register(validationRoutes, { prefix: "/api/validation" });
  await app.register(contactRoutes, { prefix: "/api/contact" });

  // The OpenAPI document is built from the route table captured above, so it
  // describes the routes this instance actually serves. Registered last so the
  // inventory is complete.
  if (shouldServeApiDocs()) {
    registerApiDocs(app, capturedRoutes());
  } else if (env.ENABLE_API_DOCS) {
    // The flag is set but the docs are not being served. Say so explicitly:
    // a silently-ignored flag is indistinguishable from a broken build, and an
    // operator who expects /docs in production needs to know it is refused on
    // purpose rather than missing.
    app.log.warn(
      { event: "api_docs_refused", nodeEnv: env.NODE_ENV },
      "ENABLE_API_DOCS is set but /docs is not served in production; an unauthenticated route inventory is reconnaissance",
    );
  }

  return app;
}

/**
 * Resolves Fastify's `trustProxy` setting from the environment.
 *
 * `request.ip` is the key every rate limiter in this app uses, and how Fastify
 * computes it depends entirely on this option:
 *
 *  - `false` (the default): `request.ip` is the immediate TCP peer. Correct
 *    when the app is directly reachable, and WRONG behind a reverse proxy —
 *    every user then shares one budget per route, so one abusive client can
 *    lock out everyone on `/login`, `/verify-pin` and friends.
 *  - `true`: `request.ip` is the leftmost entry of `X-Forwarded-For`. Only
 *    safe when a trusted proxy overwrites that header, since a directly
 *    reachable client can otherwise forge it to evade its own limit.
 *  - a number: trust exactly N hops.
 *  - a string list (IPs / CIDRs): trust only those addresses as proxies.
 *
 * The string-list form is the recommended one because it fails safe: an
 * unrecognised peer is simply not trusted.
 */
export function resolveTrustProxy(
  trustedProxies: string | undefined,
  trustedProxyCount: number | undefined,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  // Defensive about a missing value: `config/env.ts` always supplies a default,
  // but tests mock that module with a partial object, and a helper must not
  // throw on an absent optional variable.
  const list = (trustedProxies ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (list.includes("*")) return true;
  if (list.length > 0) return list;
  if (trustedProxyCount !== undefined && trustedProxyCount > 0) {
    // Fastify's `trustProxy` has no numeric form in its type, so "trust exactly
    // N hops" is expressed as the predicate it is equivalent to: a hop is
    // trusted when it is at or nearer the socket than the Nth one.
    return (_address: string, hop: number) => hop <= trustedProxyCount;
  }
  return false;
}

export function parseAllowedOrigins(raw: string): string[] {
  const origins = [
    ...new Set(
      raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    ),
  ];
  if (origins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must list at least one origin");
  }
  if (env.NODE_ENV === "production" && !origins.every((origin) => origin.startsWith("https://"))) {
    throw new Error("ALLOWED_ORIGINS must contain only https:// origins in production");
  }
  return origins;
}
