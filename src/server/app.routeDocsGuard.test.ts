import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CI must fail when a route is added without an OpenAPI entry.
//
// The gap this closes: `verifySpecMatchesRoutes` runs only at a non-production
// boot (`openapiRoutes.ts`, `NODE_ENV !== "production"`), and no CI step boots
// the API — CI runs `lint`, `typecheck` and `test`, then the Redis and migration
// checks. So the one thing that can catch an undocumented route never ran in CI.
// Worse, both existing route lists are hand-maintained:
//
//   - `openapi.test.ts` carries 49 typed `LiveRoute` entries, so a new route
//     added to neither list is invisible to it;
//   - `openapiRoutes.test.ts` derives its list from `Object.keys(ROUTE_DOCS)` and
//     then asserts `ROUTE_DOCS` against it, which compares the spec against
//     itself and can never detect a missing entry.
//
// Net effect before this file: add a route, forget `ROUTE_DOCS`, CI is green and
// you find out the next time someone boots the app locally.
//
// This test builds the REAL app, with the same module mocks the other
// app-level tests use (env, logger, database, queues, jobs) so it needs neither
// Postgres nor Redis, and asserts the real route table is fully documented.
// ---------------------------------------------------------------------------

const envState = vi.hoisted(() => ({
  env: {
    NODE_ENV: "test",
    ALLOWED_ORIGINS: "http://localhost:8081,http://localhost:19006",
  },
}));

vi.mock("../config/env.js", () => ({
  env: envState.env,
  assertEmailProviderConfigured: () => undefined,
  assertRampProviderConfigured: () => undefined,
}));

vi.mock("../config/logger.js", () => {
  const logger: Record<string, unknown> = {
    fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn(() => logger),
  };
  return { logger };
});

vi.mock("../config/database.js", () => ({
  prisma: {}, connectDatabase: vi.fn(), disconnectDatabase: vi.fn(),
}));
vi.mock("../queues/redis.connection.js", () => ({ redisConnection: {} }));
vi.mock("../queues/transaction.queue.js", () => ({ transactionQueue: { add: vi.fn() } }));
vi.mock("../queues/ramp.queue.js", () => ({ rampQueue: { add: vi.fn() } }));
vi.mock("../jobs/transaction.worker.js", () => ({}));
vi.mock("../jobs/ramp.worker.js", () => ({}));

import { buildApp } from "./app.js";
import { startRouteCapture, attachRouteCapture, capturedRoutes } from "../utils/routeInventory.js";
import { verifySpecMatchesRoutes } from "../utils/openapiRoutes.js";
import type { LiveRoute } from "../utils/routeInventory.js";

describe("every route the real app registers is documented", () => {
  beforeEach(() => {
    envState.env.NODE_ENV = "test";
    envState.env.ALLOWED_ORIGINS = "http://localhost:8081,http://localhost:19006";
  });

  it("no live route is missing from ROUTE_DOCS, and no documented route is gone", async () => {
    // Capture the route table the same way `buildApp` does, so this sees exactly
    // what production would serve — not a hand-typed approximation of it.
    startRouteCapture();
    const app = await buildApp();
    attachRouteCapture(app);
    await app.ready();

    const routes: LiveRoute[] = capturedRoutes();
    // Guard the guard: if route capture silently returned nothing this test
    // would pass while checking nothing at all.
    expect(routes.length).toBeGreaterThan(30);

    // The same assertion the dev boot makes. If a route was added without a
    // ROUTE_DOCS entry, or an entry outlived its route, this throws.
    expect(() => verifySpecMatchesRoutes(app, routes)).not.toThrow();

    await app.close();
  });

  it("the captured table is the real one, not an empty list", async () => {
    startRouteCapture();
    const app = await buildApp();
    attachRouteCapture(app);
    await app.ready();

    const urls = capturedRoutes().map((r) => `${r.method} ${r.url}`);
    // Spot-check a few routes that exist across different plugins, so this
    // cannot pass on a partial capture.
    expect(urls).toContain("GET /health");
    expect(urls).toContain("POST /api/auth/login");
    expect(urls).toContain("POST /api/auth/logout");
    expect(urls).toContain("GET /api/transaction");
    expect(urls).toContain("POST /api/transaction/external/prepare");

    await app.close();
  });
});
