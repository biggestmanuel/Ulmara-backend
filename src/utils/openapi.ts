/**
 * OpenAPI 3.1 document, generated from the live Fastify route table.
 *
 * ## Why generate rather than hand-write
 *
 * A hand-written OpenAPI file drifts: nothing makes it fail when a route
 * changes, so it is wrong within a release or two and anyone integrating
 * against it is working from fiction. This document is built by walking the
 * **live route table** that the server dispatches on, so the method, path and
 * declared schema of every route come from the registrations themselves.
 *
 * **No OpenAPI library is used.** `@fastify/swagger` +
 * `@fastify/swagger-ui` were installed for this and then removed: the only
 * thing `swagger-ui` added was a static-asset route, and it pulls in
 * `@fastify/static`, which carries a high-severity path-traversal /
 * authorization-bypass advisory (GHSA-83w8-p2f5-377r,
 * GHSA-8pvw-jcv7-9cmj) with no fixed release. Serving a few kilobytes of HTML
 * from this repo is not worth a known-vulnerable static-file server in the
 * dependency tree of a financial backend. `GET /docs/json` is the real output
 * and works with any viewer; `GET /docs` is a small dependency-free listing.
 *
 * ## The honest limitation
 *
 * The generator cannot introspect handler bodies. `zod` schemas in this
 * codebase are applied *inside* handlers (`someSchema.parse(request.body)`)
 * rather than attached to routes as Fastify JSON schemas, so nothing in the
 * route table records them. Restructuring ~40 controllers to move validation
 * into the route definitions would be a large refactor of working, tested code
 * for documentation's benefit, so it was not done.
 *
 * Instead the request schemas are **imported and attached** below. They are the
 * real zod objects the handlers validate with — the same instances — so the
 * document still cannot disagree with runtime behaviour, and a schema change is
 * still caught by the compiler. What this buys over a hand-written spec is the
 * drift guarantee: `assertSpecCoversEveryRoute()` fails the build when a route
 * is added without being documented, and `assertEveryDocumentedRouteExists()`
 * fails when a documented route is deleted.
 *
 * `zod` v4 exposes `toJSONSchema()`, so the attached schemas are converted with
 * the same library that defines them.
 *
 * ## Availability
 *
 *   GET /docs/json   the raw document — load this into Swagger Editor, Redoc,
 *                    or Postman for interactive docs
 *   GET /docs        a dependency-free route listing
 *
 * Both require `ENABLE_API_DOCS=true` and are **refused in production** even
 * then: an unauthenticated route inventory is reconnaissance. The refusal is
 * logged, so a silently-ignored flag is never mistaken for a broken build.
 */

import type { z } from "zod";
import { zodToJsonSchema } from "./zodToJsonSchema.js";
import {
  accountIdParamSchema,
  addressValidationSchema,
  chainParamSchema,
  changePinSchema,
  contactCreateSchema,
  contactUpdateSchema,
  externalPrepareSchema,
  externalSubmitSchema,
  forgotPasswordSchema,
  idParamSchema,
  loginSchema,
  paginationQuerySchema,
  paymentFulfillSchema,
  paymentRequestSchema,
  pinSchema,
  rampDepositSchema,
  rampWithdrawSchema,
  referenceParamSchema,
  registerWalletsSchema,
  resendSchema,
  settingsSchema,
  signedTxSchema,
  signupSchema,
  tokenBalancesQuerySchema,
  transactionFeeSchema,
  transactionSendSchema,
  verifySchema,
} from "./requestSchemas.js";

/** The `Authorization: Bearer <jwt>` scheme used by every authenticated route. */
const BEARER = [{ bearerAuth: [] }];

/** One registered route, as Fastify reports it. */
export interface LiveRoute {
  method: string;
  url: string;
}

/** What the document says about a route, beyond what the route table knows. */
export interface RouteDoc {
  summary: string;
  tags: string[];
  description?: string;
  auth?: boolean;
  body?: { schema: z.ZodType; description: string };
  query?: { schema: z.ZodType; description: string };
  params?: { name: string; schema: z.ZodType; description: string }[];
  response?: string;
}

/**
 * Per-route documentation, keyed `METHOD /path`.
 *
 * Every entry is checked against the live route table in both directions by the
 * `assert*` functions below, so this table and the server cannot diverge.
 */
/**
 * The full documented surface, keyed `METHOD /path`.
 *
 * Exported so the drift tests can assert against the complete table rather
 * than a hand-maintained subset that would itself drift. The generators
 * below only ever read it.
 */
export const ROUTE_DOCS: Record<string, RouteDoc> = {
  // ---- health & internal (registered without a prefix) -------------------
  "GET /health": {
    summary: "Liveness probe",
    tags: ["health"],
    description:
      "Dependency-free by design, so a database blip does not get the process killed by a restart loop. Use /health/ready for dependency checks.",
  },
  "GET /health/ready": {
    summary: "Readiness probe",
    tags: ["health"],
    description: "Verifies Postgres and Redis. Responds 503 when either is unavailable.",
  },
  "GET /internal/queues": {
    summary: "Queue depth and backlog age",
    tags: ["internal"],
    description: "Requires the INTERNAL_API_TOKEN bearer token; 404s in production when the token is unset.",
  },
  "GET /internal/config": {
    summary: "Resolved configuration (credential-free)",
    tags: ["internal"],
    description:
      "Reports which providers and chains are configured and any configuration problems worth alerting on. Never returns a secret value.",
  },

  // ---- auth --------------------------------------------------------------
  "POST /api/auth/signup": {
    summary: "Create an account",
    tags: ["auth"],
    description: "Sends a verification code to the supplied email address.",
    body: { schema: signupSchema, description: "email, an optional phone, and a password of 8-128 characters." },
  },
  "POST /api/auth/login": {
    summary: "Exchange credentials for a session token",
    tags: ["auth"],
    description: "Rate limited per IP. The returned token is a JWT bound to a server-side session row.",
    body: { schema: loginSchema, description: "email and password." },
  },
  "POST /api/auth/verify-email": {
    summary: "Submit the email verification code",
    tags: ["auth"],
    auth: true,
    description:
      "The account is taken from the session, never from the body — a caller cannot complete verification for another account.",
    body: { schema: verifySchema, description: "The 6-digit code only — no userId; identity comes from the session token." },
  },
  "POST /api/auth/verify-phone": {
    summary: "Submit the phone verification code",
    tags: ["auth"],
    auth: true,
    body: { schema: verifySchema, description: "The 6-digit code only — no userId; identity comes from the session token." },
  },
  "POST /api/auth/resend-code": {
    summary: "Resend a verification code",
    tags: ["auth"],
    auth: true,
    description: "The account is taken from the session.",
    body: { schema: resendSchema, description: "Which channel to resend to." },
  },
  "POST /api/auth/forgot-password": {
    summary: "Request a password reset email",
    tags: ["auth"],
    body: { schema: forgotPasswordSchema, description: "email only." },
  },
  "POST /api/auth/set-pin": {
    summary: "Set the transaction authorization PIN",
    tags: ["auth"],
    auth: true,
    body: { schema: pinSchema, description: "The PIN to set. First-time only: returns 409 once a PIN exists — use /change-pin to replace one." },
  },
  "POST /api/auth/verify-pin": {
    summary: "Verify the PIN for a sensitive operation",
    tags: ["auth"],
    auth: true,
    description: "Failures count towards a lockout shared with login and transfer.",
    body: { schema: pinSchema, description: "The PIN to check against the stored hash." },
  },
  "POST /api/auth/change-pin": {
    summary: "Change the PIN",
    tags: ["auth"],
    auth: true,
    body: { schema: changePinSchema, description: "The current PIN and the new one. Proves knowledge of the PIN being replaced." },
  },
  "GET /api/auth/sessions": {
    summary: "List active sessions",
    tags: ["auth"],
    auth: true,
  },
  "DELETE /api/auth/sessions/:id": {
    summary: "Revoke a session",
    tags: ["auth"],
    auth: true,
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Session id (UUID)." }],
  },
  "POST /api/auth/logout": {
    summary: "End the current session",
    description:
      "Revokes only the session that made the request, so signing out on one device leaves the " +
      "others alone. Idempotent, and takes no body: the session is identified by the bearer token. " +
      "Clients MUST call this on sign-out — deleting the token from the device alone leaves it " +
      "valid on the server until it expires.",
    tags: ["auth"],
    auth: true,
  },
  "DELETE /api/auth/me": {
    summary: "Permanently delete the account",
    tags: ["auth"],
    auth: true,
  },

  // ---- account -----------------------------------------------------------
  "GET /api/account/me": {
    summary: "Current user profile",
    tags: ["account"],
    auth: true,
  },
  "POST /api/account/create-account-id": {
    summary: "Create the caller's Ulmara Account ID",
    tags: ["account"],
    auth: true,
  },
  "GET /api/account/resolve/:accountId": {
    summary: "Resolve an Account ID for a transfer",
    tags: ["account"],
    auth: true,
    params: [{ name: "accountId", schema: accountIdParamSchema.shape.accountId, description: "10-digit Account ID." }],
  },
  "GET /api/account/:accountId": {
    summary: "Public Account ID lookup",
    tags: ["account"],
    description: "Unauthenticated by design — the Send flow resolves the recipient before a session exists.",
    params: [{ name: "accountId", schema: accountIdParamSchema.shape.accountId, description: "10-digit Account ID." }],
  },
  "PATCH /api/account/settings": {
    summary: "Update profile settings",
    tags: ["account"],
    auth: true,
    description:
      "Accepts name, photoUrl, defaultCurrency, defaultLanguage and defaultNetwork. Omit a key to " +
      "leave that setting untouched. name, photoUrl and defaultNetwork are nullable: send an " +
      "explicit null to clear one back to NULL, matching what GET /api/account/me returns for an " +
      "unset value. defaultCurrency and defaultLanguage are not nullable — they always hold a value.",
    body: { schema: settingsSchema, description: "Omit a key to leave it untouched; send an explicit null to clear name, photoUrl or defaultNetwork." },
  },

  // ---- wallet ------------------------------------------------------------
  "GET /api/wallet/balances": {
    summary: "Native and token balances for every registered wallet",
    tags: ["wallet"],
    auth: true,
    description: "A failing chain or token is reported as unavailable; it never hides the other balances.",
  },
  "GET /api/wallet/token-balances": {
    summary: "Token balances for one chain and one address",
    tags: ["wallet"],
    auth: true,
    query: {
      schema: tokenBalancesQuerySchema,
      description: "chain (UPPERCASE wire id) and the address to read. Both required.",
    },
    description:
      "One row per token configured for that chain, each carrying symbol, name, chain (lower-case " +
      "ChainId), network (UPPERCASE wire id), decimals, contractAddress and balance. Balances are " +
      "exact decimal strings — no float conversion. A chain that cannot be reached yields an empty " +
      "list rather than an error, and one unreadable token does not hide the others.",
  },
  "GET /api/wallet/addresses": {
    summary: "Registered wallet addresses",
    tags: ["wallet"],
    auth: true,
  },
  "POST /api/wallet/resolve/:accountId": {
    summary: "Resolve an Account ID to wallet addresses",
    tags: ["wallet"],
    auth: true,
    params: [{ name: "accountId", schema: accountIdParamSchema.shape.accountId, description: "10-digit Account ID." }],
  },
  "POST /api/wallet/register": {
    summary: "Register wallets for this user",
    tags: ["wallet"],
    auth: true,
    body: { schema: registerWalletsSchema, description: "1-20 addresses, each with its chain." },
  },
  "GET /api/wallet/tokens/:chain": {
    summary: "ERC-20 tokens configured for a chain's current network",
    tags: ["wallet"],
    auth: true,
    params: [{ name: "chain", schema: chainParamSchema.shape.chain, description: "UPPERCASE chain identifier." }],
  },

  // ---- transaction -------------------------------------------------------
  "GET /api/transaction": {
    summary: "List the caller's transactions",
    tags: ["transaction"],
    auth: true,
    query: { schema: paginationQuerySchema, description: "page (>=1) and limit (1-100, default 20)." },
  },
  "POST /api/transaction/send": {
    summary: "Send to another Ulmara account",
    tags: ["transaction"],
    auth: true,
    body: { schema: transactionSendSchema, description: "Exactly one of recipientAccountId or recipientAddress. Note the field is `network`, not `chain`. idempotencyKey is required." },
    description:
      "Answers with the created row plus `direction` and `counterpartyAccountId`, the same two " +
      "derived fields `GET /api/transaction` and `GET /api/transaction/{id}` return, so all three " +
      "endpoints describe a transfer identically. `direction` is always \"sent\" here: the row is by " +
      "definition outgoing from the caller. `counterpartyAccountId` is the recipient's Account ID " +
      "for an internal transfer, or the resolved raw address for an external one. Replaying the " +
      "same idempotencyKey returns the original row with this same shape.",
  },
  "POST /api/transaction/fee": {
    summary: "Estimate the network fee",
    tags: ["transaction"],
    auth: true,
    body: { schema: transactionFeeSchema, description: "recipientAddress, asset, amount and network." },
  },
  "GET /api/transaction/:id": {
    summary: "Transaction detail",
    tags: ["transaction"],
    auth: true,
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Transaction id (UUID)." }],
  },
  "GET /api/transaction/:id/status": {
    summary: "Transaction status",
    tags: ["transaction"],
    auth: true,
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Transaction id (UUID)." }],
  },
  "POST /api/transaction/:id/broadcast": {
    summary: "Broadcast a pre-signed transaction",
    tags: ["transaction"],
    auth: true,
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Transaction id (UUID)." }],
    body: { schema: signedTxSchema, description: "The serialized signed transaction." },
  },
  "POST /api/transaction/external/prepare": {
    summary: "Prepare an external-wallet transfer",
    tags: ["transaction"],
    auth: true,
    description:
      "Returns the exact transaction the client must sign, on-device. The intent is server-persisted, single-use and expiring.",
    body: { schema: externalPrepareSchema, description: "chain, asset, amount, destination address and the authorising PIN." },
  },
  "POST /api/transaction/external/:id/submit": {
    summary: "Submit a signed external-wallet transfer",
    tags: ["transaction"],
    auth: true,
    description:
      "Re-verifies the signed transaction against the stored intent — recipient, amount, target contract, value and chain — before broadcasting.",
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Transfer intent id (UUID)." }],
    body: { schema: externalSubmitSchema, description: "The serialized signed transaction plus a per-attempt idempotencyKey." },
  },

  // ---- contact -----------------------------------------------------------
  "GET /api/contact": { summary: "List saved contacts", tags: ["contact"], auth: true },
  "POST /api/contact": {
    summary: "Save a contact",
    tags: ["contact"],
    auth: true,
    body: { schema: contactCreateSchema, description: "name, plus an optional Account ID, address and chain." },
  },
  "DELETE /api/contact/:id": {
    summary: "Delete a contact",
    tags: ["contact"],
    auth: true,
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Contact id (UUID)." }],
  },
  "PATCH /api/contact/:id": {
    summary: "Rename or re-point a saved contact",
    tags: ["contact"],
    auth: true,
    description:
      "Body is { name?, accountId? } with at least one field present. Updates in place, so the " +
      "contact id is preserved — the client previously had to DELETE and re-POST, which changed " +
      "the id and lost the contact if the second call failed. 404 if the contact is missing or is " +
      "not the caller's, 404 \"Account ID not found\" for an unknown Account ID, and 409 for a name " +
      "this owner already uses on another contact.",
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Contact id (UUID)." }],
    body: { schema: contactUpdateSchema, description: "At least one of name or accountId. The contact id comes from the path and is preserved." },
  },

  // ---- payment -----------------------------------------------------------
  "POST /api/payment/request": {
    summary: "Create a payment request",
    tags: ["payment"],
    auth: true,
    body: { schema: paymentRequestSchema, description: "asset or symbol, optional amount and expiry, and an optional note of 140 characters or fewer." },
  },
  "GET /api/payment/request/:id": {
    summary: "Fetch a payment request",
    tags: ["payment"],
    description: "Unauthenticated by design — the request is shared via link or QR code.",
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Payment request id (UUID)." }],
  },
  "POST /api/payment/request/:id/fulfill": {
    summary: "Fulfil a payment request with a completed transaction",
    tags: ["payment"],
    auth: true,
    params: [{ name: "id", schema: idParamSchema.shape.id, description: "Payment request id (UUID)." }],
    body: { schema: paymentFulfillSchema, description: "The transaction that settles the request." },
  },

  // ---- ramp --------------------------------------------------------------
  "POST /api/ramp/deposit": {
    summary: "Start an NGN to crypto deposit",
    tags: ["ramp"],
    auth: true,
    body: { schema: rampDepositSchema, description: "amountNgn, in Naira. Not `amount`." },
  },
  "POST /api/ramp/withdraw": {
    summary: "Start a crypto to NGN withdrawal",
    tags: ["ramp"],
    auth: true,
    body: { schema: rampWithdrawSchema, description: "amountNgn plus the destination account number, bank code and holder name." },
  },
  "GET /api/ramp/status/:reference": {
    summary: "Ramp transaction status",
    tags: ["ramp"],
    auth: true,
    params: [{ name: "reference", schema: referenceParamSchema.shape.reference, description: "Provider reference." }],
  },
  "POST /api/ramp/webhook": {
    summary: "Provider webhook (signature-verified)",
    tags: ["ramp"],
    description:
      "Called by the ramp provider, not by clients. The HMAC signature is verified before the body is parsed or acted on, and processing is idempotent on (provider, eventId).",
  },

  // ---- validation --------------------------------------------------------
  "POST /api/validation/address": {
    summary: "Check whether an address is valid and in use on a chain",
    tags: ["validation"],
    auth: true,
    body: { schema: addressValidationSchema, description: "The address and the UPPERCASE chain id to verify it on." },
  },
};

/**
 * Converts a zod schema to JSON Schema, as OpenAPI needs.
 *
 * `io: "input"` is the default because the document describes what a client
 * SENDS. That matters for a field like `limit`, which is
 * `z.string().regex(...).default("20").transform(Number)`: its output side is a
 * `number` that no client can send, so describing the output yields an empty
 * schema. The input side is the digit string and its pattern, which is what an
 * integrator needs.
 */
function jsonSchemaOf(schema: z.ZodType, io: "input" | "output" = "input"): Record<string, unknown> {
  return zodToJsonSchema(schema, { io });
}

/** `/api/x/:id` -> `/api/x/{id}` */
function toOpenApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** Splits a zod object schema into per-field schemas for `parameters`. */
function objectShapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  const candidate = schema as unknown as { shape?: unknown; _def?: { shape?: unknown } };
  const shape = candidate.shape ?? candidate._def?.shape;
  if (!shape || typeof shape !== "object") return undefined;
  return shape as Record<string, z.ZodType>;
}

/**
 * Builds the OpenAPI `paths` object from the live route table.
 *
 * Iterating the LIVE routes (not the doc table) is what guarantees the document
 * describes the server. Undocumented routes are skipped here and reported by
 * `assertSpecCoversEveryRoute`.
 */
export function buildOpenApiPaths(routes: LiveRoute[]): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const doc = ROUTE_DOCS[`${route.method} ${route.url}`];
    if (!doc) continue;

    const parameters: Record<string, unknown>[] = [];
    for (const param of doc.params ?? []) {
      parameters.push({
        name: param.name,
        in: "path",
        required: true,
        description: param.description,
        schema: jsonSchemaOf(param.schema),
      });
    }
    if (doc.query) {
      const shape = objectShapeOf(doc.query.schema);
      for (const [name, schema] of Object.entries(shape ?? {})) {
        parameters.push({
          name,
          in: "query",
          required: false,
          description: doc.query.description,
          schema: jsonSchemaOf(schema),
        });
      }
    }

    const operation: Record<string, unknown> = {
      summary: doc.summary,
      tags: doc.tags,
      ...(doc.description ? { description: doc.description } : {}),
      ...(doc.auth ? { security: BEARER } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(doc.body
        ? {
            requestBody: {
              required: true,
              description: doc.body.description,
              content: { "application/json": { schema: jsonSchemaOf(doc.body.schema) } },
            },
          }
        : {}),
      responses: {
        200: {
          description: doc.response ?? "Success",
          content: { "application/json": { schema: { type: "object" } } },
        },
        400: {
          description: "Validation failed",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
        },
        ...(doc.auth
          ? {
              401: { description: "Missing, invalid, or expired session", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
            }
          : {}),
        429: { description: "Rate limited", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      },
    };

    const path = toOpenApiPath(route.url);
    paths[path] = { ...(paths[path] ?? {}), [route.method.toLowerCase()]: operation };
  }

  return paths;
}

/** The full OpenAPI document for a given set of live routes. */
export function buildOpenApiDocument(routes: LiveRoute[]): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Ulmara Backend API",
      version: "1.0.0",
      description:
        "Generated from the live Fastify route table, so it cannot describe a route that does not exist. " +
        "Request and parameter schemas are the same zod objects the handlers validate with. " +
        "See src/utils/openapi.ts for exactly what is and is not introspected.",
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", const: false },
            message: { type: "string" },
          },
          required: ["success", "message"],
        },
      },
    },
    paths: buildOpenApiPaths(routes),
  };
}

/** Routes the server exposes that this document does not describe. */
export function assertSpecCoversEveryRoute(routes: LiveRoute[]): string[] {
  return routes
    .map((r) => `${r.method} ${r.url}`)
    .filter((key) => !(key in ROUTE_DOCS));
}

/** Documented routes that the server no longer exposes. */
export function assertEveryDocumentedRouteExists(routes: LiveRoute[]): string[] {
  const live = new Set(routes.map((r) => `${r.method} ${r.url}`));
  return Object.keys(ROUTE_DOCS).filter((key) => !live.has(key));
}

/** Tags, derived from the doc table so they cannot drift from it. */
export function documentTags(): string[] {
  return [...new Set(Object.values(ROUTE_DOCS).flatMap((d) => d.tags))].sort();
}
