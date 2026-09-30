/**
 * Typed access to the Prisma error shape.
 *
 * Prisma signals a unique-constraint violation with `code === "P2002"`. Every
 * place in this codebase that has to distinguish "lost an idempotency race"
 * from "the write genuinely failed" needs that one check, and it used to be
 * open-coded four times in three different styles — two of them via a
 * `catch (err: any)` that also discarded type safety for the whole block.
 *
 * Narrowing here keeps the call sites on `unknown` and gives the check a name
 * that says what it means.
 */

/** Prisma's stable, documented code for a unique-constraint violation. */
const UNIQUE_VIOLATION_CODE = "P2002";

/**
 * True when `err` is a Prisma unique-constraint violation. Safe for any
 * `unknown` (a `catch` binding, a rejected value, a non-object).
 */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION_CODE
  );
}
