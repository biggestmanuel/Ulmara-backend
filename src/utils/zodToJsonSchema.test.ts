import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  strictObject,
  idParamSchema,
  accountIdParamSchema,
  chainParamSchema,
  referenceParamSchema,
  tokenBalancesQuerySchema,
  paginationQuerySchema,
  signedTxSchema,
  registerWalletsSchema,
  settingsSchema,
} from "./requestSchemas.js";
import { zodToJsonSchema } from "./zodToJsonSchema.js";

// ---------------------------------------------------------------------------
// The engine behind the published OpenAPI document.
//
// `GET /docs/json` is generated from the live route table at boot, and
// `verifySpecMatchesRoutes` fails the build if a route is undocumented. So this
// function is on the critical path of every boot AND of every CI run, and it had
// no tests of its own.
//
// The property that matters most: the document must not describe a contract the
// server does not enforce. A silently empty or wrong schema is worse than a
// build failure, because a client reads it as truth and codes against it —
// which is exactly why the frontend had to hand-audit contracts against a live
// server instead of trusting /docs/json.
//
// Note on nullability: inside an object property zod emits `anyOf: [T, {type:
// "null"}]`, NOT `type: [T, "null"]`. The latter only appears for a bare
// nullable at the root. Both are valid JSON Schema and both accept null; the
// tests below assert on `anyOf` because that is what object properties produce,
// and getting this wrong is how a test ends up asserting the generator is broken
// when it is fine.
// ---------------------------------------------------------------------------

/** Does this JSON Schema node accept null? Handles both shapes zod emits. */
function acceptsNull(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  // `type` may be the bare string "null" (an anyOf branch) or an array
  // containing it (a root-level nullable). Both must be recognised.
  if (n.type === "null") return true;
  if (Array.isArray(n.type) && n.type.includes("null")) return true;
  if (Array.isArray(n.anyOf)) return n.anyOf.some((alt) => acceptsNull(alt));
  if (Array.isArray(n.oneOf)) return n.oneOf.some((alt) => acceptsNull(alt));
  return false;
}

describe("zodToJsonSchema", () => {
  it("describes a plain object with its properties", () => {
    const schema = zodToJsonSchema(strictObject({ name: z.string(), age: z.number() }));
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(["age", "name"]);
    expect(props.name.type).toBe("string");
    expect(props.age.type).toBe("number");
  });

  it("emits additionalProperties:false for a strict object", () => {
    // This is what makes the document describe the API's real strictness. If it
    // were dropped, a client would believe unknown keys are accepted.
    expect(zodToJsonSchema(strictObject({ name: z.string() })).additionalProperties).toBe(false);
  });

  it("emits a real JSON Schema pattern for a .regex()", () => {
    const schema = zodToJsonSchema(strictObject({ pin: z.string().regex(/^\d{6}$/) }));
    const props = schema.properties as Record<string, Record<string, unknown>>;
    // Not a description string, not omitted: an actual pattern a client can use.
    expect(props.pin.pattern).toBe("^\\d{6}$");
  });

  it("describes string bounds as minLength/maxLength", () => {
    const props = zodToJsonSchema(strictObject({ name: z.string().min(2).max(8) }))
      .properties as Record<string, Record<string, unknown>>;
    expect(props.name.minLength).toBe(2);
    expect(props.name.maxLength).toBe(8);
  });

  it("describes an enum as its allowed values", () => {
    const props = zodToJsonSchema(strictObject({ chain: z.enum(["ETH", "BTC"]) }))
      .properties as Record<string, Record<string, unknown>>;
    expect(props.chain.enum).toEqual(["ETH", "BTC"]);
  });

  it("marks an optional property as not required", () => {
    const schema = zodToJsonSchema(strictObject({ a: z.string(), b: z.string().optional() }));
    expect(schema.required).toEqual(["a"]);
  });

  it("describes a nullable property as accepting null", () => {
    const props = zodToJsonSchema(strictObject({ photoUrl: z.string().nullable() }))
      .properties as Record<string, unknown>;
    expect(acceptsNull(props.photoUrl)).toBe(true);
  });

  it("does NOT mark a non-nullable property as accepting null", () => {
    const props = zodToJsonSchema(strictObject({ currency: z.string() }))
      .properties as Record<string, unknown>;
    expect(acceptsNull(props.currency)).toBe(false);
  });

  it("describes a nested object", () => {
    const props = zodToJsonSchema(strictObject({ inner: strictObject({ x: z.number() }) }))
      .properties as Record<string, Record<string, unknown>>;
    expect(props.inner.type).toBe("object");
  });

  it("describes an array with its item shape", () => {
    const props = zodToJsonSchema(strictObject({ ids: z.array(z.string()) }))
      .properties as Record<string, Record<string, unknown>>;
    expect(props.ids.type).toBe("array");
    expect((props.ids.items as Record<string, unknown>).type).toBe("string");
  });

  it("uses the input side by default and honours an explicit override", () => {
    // `.default()` means input and output differ: input may omit it, output has it.
    const withDefault = strictObject({ limit: z.string().default("20") });
    const asOutput = zodToJsonSchema(withDefault);
    expect(asOutput.required).toBeDefined();
    expect(zodToJsonSchema(withDefault, { io: "input" }).required).toBeUndefined();
  });

  it("tolerates a transform instead of throwing", () => {
    // paginationQuerySchema uses .transform() to coerce a query string to a
    // number. JSON Schema has no transform concept, and with "throw" a single
    // legitimate transform made the whole document un-generatable.
    const transformed = strictObject({
      limit: z.string().regex(/^\d+$/).transform((v) => Number(v)),
    });
    expect(() => zodToJsonSchema(transformed)).not.toThrow();
    expect(zodToJsonSchema(transformed).type).toBe("object");
  });

  it("throws when zod exposes no toJSONSchema at all", async () => {
    // The loud-failure path that does exist: if the zod version ever loses the
    // converter, the generator refuses rather than emitting nothing.
    //
    // `z` is a frozen module namespace, so the property cannot be deleted or
    // reassigned — the module has to be replaced wholesale. Hence doMock +
    // resetModules + a fresh import rather than a direct assignment.
    vi.resetModules();
    vi.doMock("zod", () => ({ z: { string: () => ({}) } }));
    try {
      const { zodToJsonSchema: guarded } = await import("./zodToJsonSchema.js");
      expect(() => guarded({} as z.ZodType)).toThrow(/toJSONSchema/);
    } finally {
      vi.doUnmock("zod");
      vi.resetModules();
    }
  });

  it("drops a construct with no wire representation instead of inventing one", () => {
    // Documents the real behaviour: `unrepresentable: "any"` applies to
    // z.date() as well as to transforms, so a date property yields a node with
    // no `type` rather than a fabricated string. No schema in src/ uses
    // z.date() — the test below proves every shared schema converts — so this
    // pins the behaviour rather than endorsing it as ideal.
    const props = zodToJsonSchema(strictObject({ at: z.date() })).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.at).not.toHaveProperty("type");
  });

  it("produces a serialisable schema for every shared request schema", () => {
    // The real value: every schema the routes actually use must convert. A new
    // schema that cannot be described breaks the document at boot, so it is
    // checked here rather than discovered by a failing CI run.
    const schemas: Record<string, z.ZodType> = {
      id: idParamSchema,
      accountId: accountIdParamSchema,
      chain: chainParamSchema,
      reference: referenceParamSchema,
      tokenBalances: tokenBalancesQuerySchema,
      pagination: paginationQuerySchema,
      signedTx: signedTxSchema,
      registerWallets: registerWalletsSchema,
      settings: settingsSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      const out = zodToJsonSchema(schema);
      expect(out, `${name} produced no schema`).toBeTruthy();
      expect(out.type, `${name} is not an object schema`).toBe("object");
      expect(() => JSON.stringify(out), `${name} is not serialisable`).not.toThrow();
    }
  });

  it("describes settingsSchema with exactly the three nullable fields", () => {
    // Regression guard for the contract the frontend codes against: a document
    // that called these string-only would tell clients null is a 400, which was
    // the original bug settingsSchema was fixed for.
    const props = zodToJsonSchema(settingsSchema).properties as Record<string, unknown>;
    for (const field of ["name", "photoUrl", "defaultNetwork"]) {
      expect(acceptsNull(props[field]), `${field} should accept null`).toBe(true);
    }
    for (const field of ["defaultCurrency", "defaultLanguage"]) {
      expect(acceptsNull(props[field]), `${field} must not accept null`).toBe(false);
    }
  });

  it("documents the chain enum in UPPERCASE, as the wire requires", () => {
    // Lower-case chain ids have been rejected by validation; a document
    // advertising lower-case would send clients straight into a 400.
    const props = zodToJsonSchema(settingsSchema).properties as Record<
      string,
      { anyOf?: { enum?: string[] }[] }
    >;
    const networkEnum = props.defaultNetwork.anyOf?.find((alt) => alt.enum)?.enum ?? [];
    expect(networkEnum.length).toBeGreaterThan(0);
    expect(networkEnum.every((c) => c === c.toUpperCase())).toBe(true);
  });
});