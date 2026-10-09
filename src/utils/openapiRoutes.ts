import type { FastifyInstance } from "fastify";
import {
  assertEveryDocumentedRouteExists,
  assertSpecCoversEveryRoute,
  buildOpenApiDocument,
  type LiveRoute,
} from "./openapi.js";

/**
 * Serves the generated OpenAPI document.
 *
 * Split out from `openapi.ts` (which is pure and directly testable) so the
 * Fastify wiring is in one small, obvious place.
 *
 * Two routes are exposed:
 *   GET /docs/json   the raw OpenAPI 3.1 document
 *   GET /docs        Swagger UI, which loads the document from the route above
 *
 * Availability is decided by the caller (`shouldServeApiDocs()`), which refuses
 * production outright.
 *
 * `verifySpecMatchesRoutes` runs in non-production only: a route added without
 * documentation is a developer error worth failing loudly on, and it cannot be
 * allowed to take down a production boot.
 */
export function registerApiDocs(app: FastifyInstance, routes: LiveRoute[]): void {
  registerDocsRoutes(app, routes);
  // Never at production boot: a documentation gap must not take the API down.
  if (process.env.NODE_ENV !== "production") verifySpecMatchesRoutes(app, routes);
}

/** Registers only the two `/docs` routes, with no drift check. */
export function registerDocsRoutes(app: FastifyInstance, routes: LiveRoute[]): void {
  const document = buildOpenApiDocument(routes);
  const spec = JSON.stringify(document);

  app.get("/docs/json", async (_request, reply) =>
    reply
      .header("content-type", "application/json; charset=utf-8")
      // The document describes the API surface, so it must not be cached by a
      // proxy that outlives a deploy.
      .header("cache-control", "no-store")
      .send(spec),
  );

  // A deliberately small, dependency-free HTML page. The interactive document
  // is /docs/json: load it into Swagger Editor, Redoc, or Postman. Bundling
  // Swagger UI here would mean shipping a static-asset server with open
  // path-traversal advisories (see the note in openapi.ts), which is not a
  // trade worth making for a development-only page.
  app.get("/docs", async (_request, reply) =>
    reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .send(docsHtml()),
  );

  app.log.info(
    { routes: routes.length, paths: Object.keys(document.paths ?? {}).length },
    "OpenAPI document generated from the live route table",
  );
}

/**
 * Fails the build when the document and the route table disagree.
 *
 * This is the drift check a hand-written spec cannot have. It runs in
 * development and in CI, never at production boot, so a missing doc entry is
 * caught before a release rather than during one.
 */
export function verifySpecMatchesRoutes(app: FastifyInstance, routes: LiveRoute[]): void {
  const undocumented = assertSpecCoversEveryRoute(routes);
  const removed = assertEveryDocumentedRouteExists(routes);
  if (undocumented.length === 0 && removed.length === 0) return;
  const parts: string[] = [];
  if (undocumented.length) parts.push(`routes missing from the OpenAPI document: ${undocumented.join(", ")}`);
  if (removed.length) parts.push(`documented routes that no longer exist: ${removed.join(", ")}`);
  app.log.error({ issues: parts }, "OpenAPI document does not match the route table");
  throw new Error(`OpenAPI drift: ${parts.join(" | ")}`);
}

function docsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ulmara Backend API</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; color: #1a1a1a; }
  code { background: #f4f4f5; padding: .1em .35em; border-radius: 3px; }
  .m { display: inline-block; min-width: 4.5rem; font-weight: 600; font-size: .8rem; }
  .GET { color: #1d4ed8; } .POST { color: #15803d; } .DELETE { color: #b91c1c; } .PATCH { color: #a16207; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1rem; margin-top: 2rem; border-bottom: 1px solid #e4e4e7; padding-bottom: .3rem; }
  .auth { color: #7c3aed; font-size: .8rem; }
</style>
</head>
<body>
<h1>Ulmara Backend API</h1>
<p>OpenAPI 3.1 document: <a href="/docs/json"><code>/docs/json</code></a>.
Generated from the live Fastify route table, so it cannot describe a route that does not exist.
Request and parameter schemas are the same zod objects the handlers validate with.</p>
<p>View it interactively by loading <code>/docs/json</code> into any OpenAPI viewer
(Swagger Editor, Redoc, Postman import).</p>
<div id="routes"></div>
<script>
fetch('/docs/json').then(r => r.json()).then(doc => {
  const el = document.getElementById('routes');
  const tags = {};
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = (op.tags && op.tags[0]) || 'other';
      (tags[tag] = tags[tag] || []).push({ path, method, op });
    }
  }
  for (const tag of Object.keys(tags).sort()) {
    const h = document.createElement('h2'); h.textContent = tag; el.appendChild(h);
    for (const { path, method, op } of tags[tag]) {
      const p = document.createElement('p');
      p.innerHTML =
        '<span class="m ' + method.toUpperCase() + '">' + method.toUpperCase() + '</span>' +
        '<code>' + path + '</code> ' + (op.summary || '') +
        (op.security ? ' <span class="auth">[bearer]</span>' : '');
      el.appendChild(p);
    }
  }
});
</script>
</body>
</html>`;
}
