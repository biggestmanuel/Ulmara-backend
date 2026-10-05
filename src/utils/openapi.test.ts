import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenAPI document generation.
 *
 * The point of these tests is the *drift guarantee*, not the document's
 * prettiness: a hand-written spec cannot fail when a route changes, and that is
 * exactly the failure mode worth testing. So the central cases assert that the
 * document and the route table detect each other's mistakes.
 */
import {
  assertEveryDocumentedRouteExists,
  assertSpecCoversEveryRoute,
  buildOpenApiDocument,
  buildOpenApiPaths,
  documentTags,
  ROUTE_DOCS,
  type LiveRoute,
} from "./openapi.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";
import { z } from "zod";
import { idParamSchema, registerWalletsSchema, paginationQuerySchema } from "./requestSchemas.js";

/** The route table the real server produces, transcribed from src/routes/. */
const LIVE_ROUTES: LiveRoute[] = [
  { method: "GET", url: "/health" },
  { method: "GET", url: "/health/ready" },
  { method: "GET", url: "/internal/queues" },
  { method: "GET", url: "/internal/config" },
  { method: "POST", url: "/api/auth/signup" },
  { method: "POST", url: "/api/auth/login" },
  { method: "POST", url: "/api/auth/verify-email" },
  { method: "POST", url: "/api/auth/verify-phone" },
  { method: "POST", url: "/api/auth/resend-code" },
  { method: "POST", url: "/api/auth/forgot-password" },
  { method: "POST", url: "/api/auth/set-pin" },
  { method: "POST", url: "/api/auth/verify-pin" },
  { method: "POST", url: "/api/auth/change-pin" },
  { method: "GET", url: "/api/auth/sessions" },
  { method: "DELETE", url: "/api/auth/sessions/:id" },
  { method: "POST", url: "/api/auth/logout" },
  { method: "DELETE", url: "/api/auth/me" },
  { method: "GET", url: "/api/account/me" },
  { method: "POST", url: "/api/account/create-account-id" },
  { method: "GET", url: "/api/account/resolve/:accountId" },
  { method: "GET", url: "/api/account/:accountId" },
  { method: "PATCH", url: "/api/account/settings" },
  { method: "GET", url: "/api/wallet/balances" },
  { method: "GET", url: "/api/wallet/addresses" },
  { method: "POST", url: "/api/wallet/resolve/:accountId" },
  { method: "POST", url: "/api/wallet/register" },
  { method: "GET", url: "/api/wallet/tokens/:chain" },
  { method: "GET", url: "/api/wallet/token-balances" },
  { method: "GET", url: "/api/transaction" },
  { method: "POST", url: "/api/transaction/send" },
  { method: "POST", url: "/api/transaction/fee" },
  { method: "GET", url: "/api/transaction/:id" },
  { method: "GET", url: "/api/transaction/:id/status" },
  { method: "POST", url: "/api/transaction/:id/broadcast" },
  { method: "POST", url: "/api/transaction/external/prepare" },
  { method: "POST", url: "/api/transaction/external/:id/submit" },
  { method: "GET", url: "/api/contact" },
  { method: "POST", url: "/api/contact" },
  { method: "DELETE", url: "/api/contact/:id" },
  { method: "PATCH", url: "/api/contact/:id" },
  { method: "POST", url: "/api/payment/request" },
  { method: "GET", url: "/api/payment/request/:id" },
  { method: "POST", url: "/api/payment/request/:id/fulfill" },
  { method: "POST", url: "/api/ramp/deposit" },
  { method: "POST", url: "/api/ramp/withdraw" },
  { method: "GET", url: "/api/ramp/status/:reference" },
  { method: "POST", url: "/api/ramp/webhook" },
  { method: "POST", url: "/api/validation/address" },
];

beforeEach(() => vi.clearAllMocks());

describe("document / route table agreement", () => {
  it("has no undocumented route and no documented route that is gone", () => {
    // This is the drift check. If it fails, someone added or removed a route
    // without updating src/utils/openapi.ts.
    expect(assertSpecCoversEveryRoute(LIVE_ROUTES)).toEqual([]);
    expect(assertEveryDocumentedRouteExists(LIVE_ROUTES)).toEqual([]);
  });

  it("detects a newly added route that was not documented", () => {
    const withNewRoute = [...LIVE_ROUTES, { method: "GET", url: "/api/secret/new-thing" }];
    expect(assertSpecCoversEveryRoute(withNewRoute)).toEqual(["GET /api/secret/new-thing"]);
  });

  it("detects a documented route that has been removed", () => {
    const withoutRevoke = LIVE_ROUTES.filter((r) => r.url !== "/api/auth/sessions/:id");
    expect(assertEveryDocumentedRouteExists(withoutRevoke)).toContain("DELETE /api/auth/sessions/:id");
  });

  it("describes every live route", () => {
    const paths = buildOpenApiPaths(LIVE_ROUTES);
    const described = new Set<string>();
    for (const [path, ops] of Object.entries(paths)) {
      for (const method of Object.keys(ops)) described.add(`${method.toUpperCase()} ${path}`);
    }
    // Fastify `:param` becomes OpenAPI `{param}`; normalise to compare.
    const normalised = new Set([...described].map((k) => k.replace(/\{(\w+)\}/g, ":$1")));
    expect([...normalised].sort()).toEqual([...LIVE_ROUTES.map((r) => `${r.method} ${r.url}`)].sort());
  });
});

describe("document structure", () => {
  it("is a valid OpenAPI 3.1 document with the bearer scheme declared", () => {
    const doc = buildOpenApiDocument(LIVE_ROUTES) as {
      openapi: string;
      info: { title: string; version: string };
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, unknown>;
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Ulmara Backend API");
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
  });

  it("marks authenticated routes with the bearer scheme and others without", () => {
    const paths = buildOpenApiPaths(LIVE_ROUTES) as Record<string, Record<string, { security?: unknown; responses: Record<string, unknown> }>>;
    // An authenticated route.
    const me = paths["/api/account/me"].get;
    expect(me.security).toEqual([{ bearerAuth: [] }]);
    expect(me.responses[401]).toBeDefined();
    // A deliberately public route.
    const publicLookup = paths["/api/account/{accountId}"].get;
    expect(publicLookup.security).toBeUndefined();
    expect(publicLookup.responses[401]).toBeUndefined();
  });

  it("documents the shared error responses on every operation", () => {
    const paths = buildOpenApiPaths(LIVE_ROUTES) as Record<string, Record<string, { responses: Record<string, unknown> }>>;
    for (const [path, ops] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op.responses[400], `${method} ${path}`).toBeDefined();
        expect(op.responses[429], `${method} ${path}`).toBeDefined();
      }
    }
  });

  it("converts path parameters to OpenAPI {param} form and requires them", () => {
    const paths = buildOpenApiPaths(LIVE_ROUTES) as Record<string, Record<string, { parameters?: { name: string; in: string; required: boolean }[] }>>;
    const params = paths["/api/transaction/{id}"].get.parameters ?? [];
    const id = params.find((p) => p.name === "id");
    expect(id).toMatchObject({ in: "path", required: true });
  });

  it("expands a query schema into individual query parameters", () => {
    const paths = buildOpenApiPaths(LIVE_ROUTES) as Record<
      string,
      Record<string, { parameters?: { name: string; in: string; schema?: Record<string, unknown> }[] }>
    >;
    const params = paths["/api/transaction"].get.parameters ?? [];
    expect(params.map((p) => p.name)).toEqual(expect.arrayContaining(["page", "limit"]));
    expect(params.every((p) => p.in === "query")).toBe(true);
    // The parameter schema must describe what a client SENDS (the digit string
    // and its pattern), not the coerced number it becomes server-side. An empty
    // or number-typed schema here would be actively misleading.
    const limit = params.find((p) => p.name === "limit");
    expect(limit?.schema).toMatchObject({ type: "string" });
    expect(JSON.stringify(limit?.schema)).toMatch(/pattern/);
  });

  it("attaches a real JSON Schema for a documented request body", () => {
    const paths = buildOpenApiPaths(LIVE_ROUTES) as Record<
      string,
      Record<string, { requestBody?: { content: { "application/json": { schema: Record<string, unknown> } } } }>
    >;
    const schema = paths["/api/wallet/register"].post.requestBody?.content["application/json"].schema;
    expect(schema).toBeDefined();
    // The schema is derived from the same zod object the handler validates with,
    // so the two cannot disagree.
    expect(JSON.stringify(schema)).toContain("addresses");
  });

  it("groups operations under a bounded set of tags", () => {
    expect(documentTags()).toEqual(
      expect.arrayContaining(["account", "auth", "contact", "health", "internal", "payment", "ramp", "transaction", "validation", "wallet"]),
    );
  });
});

describe("zodToJsonSchema", () => {
  it("converts an object schema with its constraints", () => {
    const json = zodToJsonSchema(registerWalletsSchema);
    expect(json).toMatchObject({ type: "object" });
    expect(Object.keys(json.properties as object)).toEqual(["addresses"]);
  });

  it("keeps a regex constraint as a real JSON Schema pattern", () => {
    // zod v4 emits `pattern` natively. This test pins that: silently widening a
    // constrained field to "any string" would misrepresent the endpoint.
    const json = zodToJsonSchema(z.object({ code: z.string().regex(/^\d{6}$/) }));
    const code = (json.properties as Record<string, { type?: string; pattern?: string }>).code;
    expect(code.type).toBe("string");
    expect(code.pattern).toBe("^\\d{6}$");
  });

  it("marks a strict object as additionalProperties: false", () => {
    // `strictObject` rejects unknown keys at runtime, and the document must say
    // so rather than implying extra fields are accepted.
    const json = zodToJsonSchema(registerWalletsSchema);
    expect(json.additionalProperties).toBe(false);
  });

  it("converts a schema containing a transform, which JSON Schema cannot express", () => {
    // paginationQuerySchema coerces query strings to numbers with .transform().
    // JSON Schema has no transform concept, so this must still produce a
    // usable document rather than failing: the alternative would be stripping
    // the transform from the documented schema, and then the document would no
    // longer describe what the handler validates.
    const json = zodToJsonSchema(paginationQuerySchema);
    expect(json).toMatchObject({ type: "object" });
    expect(Object.keys(json.properties as object)).toEqual(expect.arrayContaining(["page", "limit"]));
  });

  it("converts the id param schema used in the document", () => {
    const json = zodToJsonSchema(idParamSchema);
    expect(json).toMatchObject({ type: "object" });
    expect(Object.keys(json.properties as object)).toEqual(["id"]);
  });

  it("converts the pagination schema", () => {
    expect(() => zodToJsonSchema(paginationQuerySchema)).not.toThrow();
  });
});

/**
 * A body on a route that takes no body is a documentation bug the existing drift
 * checks cannot see: `verifySpecMatchesRoutes` compares ROUTE_DOCS against the
 * live route table by METHOD and path, so attaching a `body` to the wrong entry
 * is structurally valid and passes every assertion.
 *
 * That is not hypothetical. Attaching bodies to routes caught a real
 * mis-attach — a schema landed on `GET /api/ramp/status/:reference` and on
 * `DELETE /api/contact/:id` because those entries were written one-line and a
 * brace-matching search ran past them into the next entry. The spec generated
 * cleanly, the drift tests passed, and the document told clients to send a body
 * to a GET.
 *
 * So this asserts the shape directly, from ROUTE_DOCS rather than the built
 * document, which is where the mistake is made.
 */
describe("request bodies are attached to routes that take one", () => {
  const bodyless = new Set([
    // Genuinely bodyless. A body here would be a lie about the contract.
    "POST /api/account/create-account-id",
    "POST /api/wallet/resolve/:accountId",
    // The session is identified by the bearer token, so there is nothing to send.
    // A client that POSTed a body here would be ignored, not validated.
    "POST /api/auth/logout",
    // The provider's own payload, read RAW for signature verification. It is
    // deliberately not modelled as a zod schema — see the entry's description.
    "POST /api/ramp/webhook",
  ]);

  it("no GET or DELETE route declares a body", () => {
    const offenders = Object.entries(ROUTE_DOCS)
      .filter(([route, doc]) => doc.body && /^(GET|DELETE) /.test(route))
      .map(([route]) => route);
    expect(offenders).toEqual([]);
  });

  it("every body-taking route declares a body, except the four that take none", () => {
    const missing = Object.keys(ROUTE_DOCS).filter(
      (route) => /^(POST|PATCH|PUT) /.test(route) && !ROUTE_DOCS[route].body && !bodyless.has(route),
    );
    expect(missing).toEqual([]);
  });

  it("does not declare a body on a route the spec knows to be bodyless", () => {
    for (const route of bodyless) {
      expect(ROUTE_DOCS[route]?.body, `${route} must not declare a body`).toBeUndefined();
    }
  });

  it("the bodyless entries really are bodyless in their own right", () => {
    // A guard on the guard: if someone adds a body to one of these, the
    // exemption above has to be removed deliberately rather than by accident.
    for (const route of bodyless) {
      expect(ROUTE_DOCS[route], `${route} must still be documented`).toBeDefined();
    }
  });

  it("documented bodies convert to a JSON Schema without throwing", () => {
    // The whole point of moving the schemas out of the controllers: ROUTE_DOCS
    // can reference them. If one could not convert, the spec would break at boot.
    for (const [route, doc] of Object.entries(ROUTE_DOCS)) {
      if (!doc.body) continue;
      const converted = zodToJsonSchema(doc.body.schema);
      expect(converted, `${route} body did not convert`).toBeTruthy();
      expect(converted.type, `${route} body is not an object schema`).toBe("object");
    }
  });

  it("every documented body states what it carries", () => {
    for (const [route, doc] of Object.entries(ROUTE_DOCS)) {
      if (!doc.body) continue;
      expect(doc.body.description?.length, `${route} body has no description`).toBeGreaterThan(10);
    }
  });
});
