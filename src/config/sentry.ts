import * as Sentry from "@sentry/node";
import { env } from "./env.js";
import { logger } from "./logger.js";

/**
 * Sentry integration.
 *
 * Entirely env-driven and entirely optional: with SENTRY_DSN unset nothing
 * here initialises Sentry and the app behaves exactly as before, so a
 * misconfigured or missing DSN can never break startup or request handling.
 *
 * It augments — never replaces — the pino logs. pino remains the local/system
 * log of record; Sentry receives the error context that a log line cannot
 * carry (stack grouping, release, environment, breadcrumbs).
 */

let initialised = false;

export function isSentryEnabled(): boolean {
  return Boolean(env.SENTRY_DSN);
}

export function initSentry(): void {
  if (initialised || !env.SENTRY_DSN) {
    if (!env.SENTRY_DSN) {
      logger.debug("SENTRY_DSN is not set; error tracking is disabled");
    }
    return;
  }
  initialised = true;

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    debug: env.SENTRY_DEBUG,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // @sentry/node v11 renamed the continuous-profiling knob from
    // `profilesSampleRate` to `profileSessionSampleRate`. The env var keeps its
    // public name so existing deployments and .env files stay valid.
    profileSessionSampleRate: env.SENTRY_PROFILES_SAMPLE_RATE,
    integrations: [Sentry.httpIntegration(), Sentry.prismaIntegration()],
    // @sentry/node v11 dropped the old `sendDefaultPii` boolean in favour of an
    // explicit `dataCollection` block. The v11 DEFAULTS are permissive (bodies,
    // cookies, query params and bound DB parameters are all collected), so
    // simply deleting the old option would have quietly started shipping
    // request bodies and PINs to Sentry. Every collector is therefore turned
    // off explicitly: a financial backend must not put user payloads on a third
    // party, and `scrubSentryEvent` below stays as defence in depth for
    // anything a caller attaches to a scope by hand.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    // Sentry v11 auto-detects the hostname; the hostname of a production worker
    // is infrastructure detail, not something we need in the event payload.
    includeServerName: false,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });

  // Process-level crashes: Sentry owns the report, pino keeps a local copy.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    Sentry.captureException(err);
    void Sentry.flush(5_000).finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err }, "Unhandled promise rejection");
    Sentry.captureException(err);
    void Sentry.flush(5_000);
  });

  logger.info(
    { event: "sentry_initialised", environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV },
    "Sentry error tracking is active",
  );
}

const SENSITIVE_KEY = /(pin|password|passcode|secret|token|authorization|cookie|mnemonic|seed|privatekey|private_key|jwt|session|apikey|api_key|dsn)/i;

/** Anything whose key suggests a credential is replaced with a marker. */
const REDACTED = "[redacted]";

/**
 * Defence in depth: even if a caller passes a sensitive field into a Sentry
 * scope, it is stripped before it leaves the process. Recurses through nested
 * objects and truncates long strings that could be signed payloads.
 */
export function scrubSentryEvent<T>(event: T): T {
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 6) return "[truncated]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      return value.length > 512 ? `${value.slice(0, 512)}...[truncated]` : value;
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => walk(item, depth + 1));
    if (value instanceof Error) {
      // Keep name/message/stack but never attach custom enumerable props that
      // might carry request bodies.
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        out[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(val, depth + 1);
      }
      return out;
    }
    return value;
  };
  return walk(event, 0) as T;
}

/** Reports a caught error with safe, explicitly-whitelisted context. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!isSentryEnabled()) return;
  const safeContext = scrubSentryEvent(context ?? {});
  if (err instanceof Error) {
    Sentry.captureException(err, { extra: safeContext });
  } else {
    Sentry.captureMessage(String(err), { level: "error", extra: safeContext });
  }
}

/**
 * The single entry point services should use for an unexpected failure: it
 * writes the pino log line (always) and reports to Sentry (only when a DSN is
 * configured), so a service never has to know which is active.
 */
export function reportError(
  err: unknown,
  message: string,
  context?: Record<string, unknown>,
): void {
  const safeContext = scrubSentryEvent(context ?? {});
  logger.error({ err, ...(safeContext) }, message);
  if (!isSentryEnabled()) return;
  if (err instanceof Error) {
    Sentry.captureException(err, { extra: { ...safeContext, message } });
  } else {
    Sentry.captureMessage(String(err), { level: "error", extra: { ...safeContext, message } });
  }
}

export async function flushSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialised) return;
  await Sentry.flush(timeoutMs);
}

/**
 * Test seam: forget that init() has run, so a test can exercise the crash
 * handler registration more than once. Never call this in application code.
 */
export function resetSentryForTests(): void {
  initialised = false;
}
