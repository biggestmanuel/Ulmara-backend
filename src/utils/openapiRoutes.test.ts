import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

/**
 * The `/docs` endpoints, exercised through a real Fastify instance.
 *
 * What matters here is the availability contract, not the HTML:
 *  - off by default, so a default boot exposes no route inventory;
 *  - refused in PRODUCTION even when explicitly enabled, and the refusal is
 *    logged (a silently-ignored flag is indistinguishable from a broken build).
 */

const { envState } = vi.hoisted(() => ({
  envState: { env: { ENABLE_API_DOCS: false, NODE_ENV: "development" } },
}));

vi.mock("../config/env.js", () => ({ env: envState.env }));

import { registerApiDocs, registerDocsRoutes, verifySpecMatchesRoutes } from "./openapiRoutes.js";
import { shouldServeApiDocs } from "./routeInventory.js";
import { buildOpenApiPaths, ROUTE_DOCS, type LiveRoute } from "./openapi.js";

/**
 * The complete documented surface, derived from `ROUTE_DOCS` rather than
 * transcribed here. A hand-written subset in a drift test is exactly the thing
 * that drifts, so this reads the single source of truth instead.
 */
const ROUTES: LiveRoute[] = Object.keys(ROUTE_DOCS).map((key) => {
  const [method, url] = key.split(" ");
  return { method, url };
});

/** A few routes used by the more specific assertions below. */
const has = (method: string, url: string): boolean =>
  ROUTES.some((r) => r.method === method && r.url === url);

/**
 * Build an app with the docs routes registered, as app.ts does.
 *
 * Drift verification is skipped by default so a test can register a DELIBERATE
 * subset and assert the document follows the route table rather than the doc
 * table. The drift assertions below call `verifySpecMatchesRoutes` directly.
 */
async function withDocs(routes: LiveRoute[] = ROUTES, verifyDrift = false) {
  const app = Fastify({ logger: false });
  if (verifyDrift) {
    registerApiDocs(app, routes);
  } else {
    // Most cases here register a DELIBERATE subset of the route table, which
    // the drift check would (correctly) reject. `registerDocsRoutes` is the same
    // wiring without that assertion, so these tests isolate the serving behaviour
    // while the drift assertion gets its own coverage below.
    registerDocsRoutes(app, routes);
  }
  await app.ready();
  return app;
}

beforeEach(() => {
  envState.env.ENABLE_API_DOCS = false;
  envState.env.NODE_ENV = "development";
});

describe("the derived route table", () => {
  it("contains the routes the other tests rely on", () => {
    // Guards the derivation above: if ROUTE_DOCS changed shape, these fail loudly
    // rather than silently testing nothing.
    expect(has("GET", "/api/account/me")).toBe(true);
    expect(has("GET", "/api/account/:accountId")).toBe(true);
    expect(has("POST", "/api/wallet/register")).toBe(true);
    expect(has("GET", "/api/transaction")).toBe(true);
    expect(has("DELETE", "/api/contact/:id")).toBe(true);
  });
});

describe("shouldServeApiDocs", () => {
  it("is false unless explicitly enabled", () => {
    expect(shouldServeApiDocs()).toBe(false);
  });

  it("is true in development once enabled", () => {
    envState.env.ENABLE_API_DOCS = true;
    expect(shouldServeApiDocs()).toBe(true);
  });

  it("is false in production even when enabled", () => {
    envState.env.ENABLE_API_DOCS = true;
    envState.env.NODE_ENV = "production";
    expect(shouldServeApiDocs()).toBe(false);
  });
});

describe("GET /docs/json", () => {
  it("serves a valid OpenAPI document", async () => {
    const app = await withDocs();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");

    const doc: { openapi: string; paths: Record<string, unknown> } = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/api/account/{accountId}");
    await app.close();
  });

  it("is not cacheable, so a proxy cannot outlive a deploy", async () => {
    const app = await withDocs();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("only describes routes that are actually registered", async () => {
    // Passing a subset must produce a subset document, not the full table.
    const app = await withDocs([{ method: "GET", url: "/health" }]);
    const doc: { paths: Record<string, unknown> } = (
      await app.inject({ method: "GET", url: "/docs/json" })
    ).json();
    expect(Object.keys(doc.paths)).toEqual(["/health"]);
    await app.close();
  });
});

describe("GET /docs", () => {
  it("serves an HTML page", async () => {
    const app = await withDocs();
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!doctype html>");
    await app.close();
  });
});

describe("drift detection", () => {
  it("does not throw when the document and the routes agree", () => {
    // The drift check is wired into a real boot by app.ts, so this is the check
    // that would otherwise only run when someone starts the server by hand.
    expect(() => verifySpecMatchesRoutes({ log: { error: vi.fn() } } as never, ROUTES)).not.toThrow();
  });

  it("is enforced on a real boot, not only when called directly", async () => {
    // Same code path app.ts takes when ENABLE_API_DOCS is on in development.
    await expect(withDocs(ROUTES, true)).resolves.toBeDefined();
  });

  it("throws when a live route is undocumented", () => {
    const app = { log: { error: vi.fn() } } as never;
    expect(() => verifySpecMatchesRoutes(app, [...ROUTES, { method: "GET", url: "/api/secret" }]))
      .toThrow(/OpenAPI drift/);
  });

  it("throws when a documented route has been removed", () => {
    const app = { log: { error: vi.fn() } } as never;
    const withoutContact = ROUTES.filter((r) => r.url !== "/api/contact/:id");
    expect(() => verifySpecMatchesRoutes(app, withoutContact)).toThrow(/no longer exist/);
  });
});

describe("route synthesis", () => {
  it("does not treat Fastify's automatic HEAD routes as undocumented", () => {
    // Fastify adds HEAD for every GET; the document models only the GET, and a
    // naive check would report every single one as drift.
    const paths = buildOpenApiPaths(ROUTES);
    expect(Object.keys(paths["/api/account/{accountId}"])).toEqual(["get"]);
  });
});
