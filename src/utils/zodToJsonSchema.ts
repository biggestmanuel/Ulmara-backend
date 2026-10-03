import { z } from "zod";

/**
 * zod schema -> JSON Schema, for the OpenAPI document.
 *
 * ## Why this exists
 *
 * zod v4 ships `z.toJSONSchema()`, so no third-party converter is needed. It is
 * wrapped rather than called directly for two reasons:
 *
 *  1. **Options are pinned in one place.** zod's defaults are target-shaped
 *     for the runtime (it strips `undefined`, keeps `.default()` values), and
 *     the OpenAPI side wants the wire shape. The settings below describe what a
 *     request body actually looks like on the wire.
 *
 *  2. **It fails loudly.** If a schema cannot be converted, the generator
 *     throws instead of emitting `{}`. A silently empty schema in a published
 *     document is worse than a build failure, because it looks valid.
 */

export interface ToJsonSchemaOptions {
  /** Which side of the schema to describe (zod's `io`). */
  io?: "input" | "output";
  /**
   * What to do with a construct JSON Schema cannot express.
   *
   * `unrepresentable: "any"` is the default here on purpose, and the reason is
   * specific to this codebase: `paginationQuerySchema` uses `.transform()` to
   * coerce a query string to a number, and JSON Schema genuinely has no
   * transform concept. With `"throw"`, a single legitimate transform anywhere
   * in a schema made the whole document un-generatable — so the alternative was
   * to strip the transforms from the documented schema, which would mean the
   * document no longer described what the handler validates.
   *
   * What IS still strict: a schema that is not an object/string/number shape
   * (a `z.date()`, say) is dropped rather than described as `{}` where a client
   * would believe it is free-form. The test suite pins that behaviour.
   */
  unrepresentable?: "throw" | "any";
}

/**
 * Converts a zod schema to JSON Schema (draft 2020-12, the OpenAPI 3.1 dialect).
 *
 * See `ToJsonSchemaOptions.unrepresentable` for why transforms are tolerated.
 */
export function zodToJsonSchema(schema: z.ZodType, options: ToJsonSchemaOptions = {}): Record<string, unknown> {
  const toJsonSchema = (z as unknown as {
    toJSONSchema?: (s: z.ZodType, o?: Record<string, unknown>) => Record<string, unknown>;
  }).toJSONSchema;

  if (typeof toJsonSchema !== "function") {
    throw new Error(
      "zod does not expose toJSONSchema(); the OpenAPI document cannot be generated from zod schemas",
    );
  }

  // No `override` is needed: zod v4 already emits a `.regex()` as a real JSON
  // Schema `pattern` (verified — `z.string().regex(/^\d{6}$/)` becomes
  // `{"type":"string","pattern":"^\\d{6}$"}`), and it sets
  // `additionalProperties: false` for a strict object. Hand-rolling an override
  // to re-describe that would only be a second, weaker source of truth.
  return toJsonSchema(schema, {
    target: "draft-2020-12",
    io: options.io ?? "output",
    unrepresentable: options.unrepresentable ?? "any",
  });
}
