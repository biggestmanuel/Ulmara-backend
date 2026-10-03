import { env } from "../config/env.js";

/**
 * Collects the live route table.
 *
 * Fastify has no public "give me every registered route" API, but it does emit
 * an `onRoute` hook for each registration. Capturing those is the supported
 * way to build a route inventory, and — importantly — it reports exactly what
 * the server dispatches on, prefixes included. That is what makes the OpenAPI
 * document trustworthy: it is derived from the same registrations the server
 * uses, not from a list maintained alongside them.
 */
export interface LiveRoute {
  method: string;
  url: string;
}

/**
 * Starts recording every route registered from now on.
 *
 * Must be called BEFORE the route plugins are registered. Returns the live
 * array, which is filled in place as routes register.
 */
export function startRouteCapture(): LiveRoute[] {
  const routes: LiveRoute[] = [];
  // The hook is installed via the instance in app.ts; see `attachRouteCapture`.
  captured = routes;
  return routes;
}

let captured: LiveRoute[] | null = null;

/**
 * Routes that are not part of the documented API surface.
 *
 * Fastify synthesises these automatically, so they appear in the route table
 * without anyone registering them and must not be treated as drift:
 *
 *  - `HEAD /x` — Fastify adds HEAD for every GET. It is the same operation, not
 *    a new one, and OpenAPI does not model it separately.
 *  - `OPTIONS *` — added by the CORS plugin for preflight.
 *  - `/docs`, `/docs/json` — the documentation endpoints themselves, which are
 *    conditional on ENABLE_API_DOCS and must not appear in their own document.
 *  - `GET /ws` — the WebSocket upgrade endpoint, which is not an HTTP JSON API
 *    and is documented in README.md instead.
 */
function isSynthesised(method: string, url: string): boolean {
  if (method === "HEAD") return true;
  if (method === "OPTIONS") return true;
  if (url === "/ws") return true;
  if (url === "/docs" || url === "/docs/json") return true;
  return false;
}

/**
 * The slice of `FastifyInstance` this module needs.
 *
 * Declared structurally rather than importing `FastifyInstance`, so a test can
 * pass a plain object and the module stays free of a dependency on Fastify
 * itself. `FastifyInstance` satisfies it.
 */
export interface OnRouteCapable {
  addHook(name: "onRoute", hook: (route: unknown) => void): unknown;
}

/** Installs the `onRoute` hook on an instance. Call before registering routes. */
export function attachRouteCapture(app: OnRouteCapable): void {
  app.addHook("onRoute", (route: unknown) => {
    const r = route as { method?: string | string[]; url?: string; method1?: string; url1?: string };
    // Fastify reports a method as an array when a route answers several verbs.
    const methods = Array.isArray(r.method) ? r.method : [r.method ?? r.method1].filter(Boolean);
    const url = r.url ?? r.url1;
    if (!url) return;
    for (const method of methods as string[]) {
      const upper = method.toUpperCase();
      if (isSynthesised(upper, url)) continue;
      captured?.push({ method: upper, url });
    }
  });
}

/** The routes recorded so far. */
export function capturedRoutes(): LiveRoute[] {
  return captured ?? [];
}

/**
 * True when the OpenAPI document should be served.
 *
 * Off unless explicitly enabled, and refused in production: an unauthenticated
 * inventory of every route, its auth requirement and its parameters is
 * reconnaissance, not documentation.
 */
export function shouldServeApiDocs(): boolean {
  return env.ENABLE_API_DOCS && env.NODE_ENV !== "production";
}
