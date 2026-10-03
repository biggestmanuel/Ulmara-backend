import { parseUnits, formatUnits } from "ethers";
import { z } from "zod";

/**
 * Exact money <-> base-unit conversion, and the validation that guards it.
 *
 * ## Why this module exists
 *
 * A base unit is an integer: 1 SOL = 1_000_000_000 lamports, 1 TRX =
 * 1_000_000 sun, 1 TON = 1_000_000_000 nanotons. Every amount in this codebase
 * crosses that boundary twice — display string in, base units out to the chain,
 * and base units back in from the chain.
 *
 * Doing that with floating point loses real money. Measured on this codebase's
 * inputs before the fix (see `money.test.ts` for the permanent regression
 * tests):
 *
 *   "707273841233.73715227" SOL
 *     float : 707273841233737200000  lamports
 *     exact : 707273841233737152270  lamports   (47,730 lamports lost)
 *
 *   "52060961747.611969" TRX
 *     float : 52060961747611970  sun
 *     exact : 52060961747611969  sun   (off by one unit, in the wrong direction)
 *
 *   balance 21000000000000001 nanoton, read back for display
 *     float : "21000000"            <- the entire fractional part vanishes
 *     exact : "21000000.000000001"
 *
 * `Math.round` hides the error for small amounts, which is why the bug is
 * invisible in casual testing and only appears once an amount is large enough
 * for the float mantissa (53 bits) to run out — i.e. on exactly the
 * high-supply tokens people actually trade.
 *
 * ## The rule
 *
 * **No arithmetic on a money amount may ever go through `Number`.** Convert once
 * at the boundary with `toBaseUnits` / `fromBaseUnits` and carry a `bigint`
 * (or an exact decimal string) from then on. These two functions are the only
 * sanctioned crossing point, so every adapter shares one proven implementation.
 *
 * They delegate to `ethers`' `parseUnits`/`formatUnits`, which are pure string
 * and BigInt routines with no chain coupling. They were already the basis of
 * the EVM path (verified on-chain by `npm run verify:tokens`); reusing them
 * here is what makes SOL/TRX/TON exact by the same construction rather than by
 * a parallel implementation that can drift.
 */

/** Conversion between a decimal display string and integer base units. */
export interface UnitScale {
  /** Number of decimal places the asset's base unit has (SOL 9, TRX 6, ...). */
  readonly decimals: number;
}

/**
 * Decimal display string -> exact base units.
 *
 * Throws on anything that is not a plain non-negative decimal, or that carries
 * more decimal places than the asset supports. Callers should validate first
 * (see {@link moneyString}) so the failure surfaces as a 400, not a 500.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  return parseUnits(amount, decimals);
}

/**
 * Exact base units -> decimal display string, with no trailing zeros.
 *
 * Exact for every value, including ones a float cannot represent.
 *
 * `ethers` already trims partial trailing zeros (`1.5` stays `1.5`, `1.500`
 * becomes `1.5`) but leaves an all-zero fraction attached, rendering `0` and
 * `21` as `"0.0"` and `"21.0"`. Every code path this replaces produced `"0"`
 * and `"21"` (`String(base / 10**d)`), and clients compare these balance
 * strings, so the all-zero fraction is dropped here. Nothing else differs.
 */
export function fromBaseUnits(value: bigint, decimals: number): string {
  return formatUnits(value, decimals).replace(/\.0+$/, "");
}

/** Number of digits after the decimal point in a plain decimal string. */
export function decimalPlacesOf(amount: string): number {
  const dot = amount.indexOf(".");
  return dot === -1 ? 0 : amount.length - dot - 1;
}

/** True when a plain decimal string represents a value strictly greater than zero. */
export function isPositiveDecimalString(amount: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(amount)) return false;
  const [whole, frac = ""] = amount.split(".");
  return /[1-9]/.test(whole) || /[1-9]/.test(frac);
}

/**
 * The widest amount the ledger can store: Prisma `Decimal(36, 18)` is 18
 * integer digits and 18 fractional digits. An amount outside that shape cannot
 * round-trip through the database, so it is rejected at the edge rather than
 * becoming a 500 from a driver error later.
 */
export const MAX_AMOUNT_INTEGER_DIGITS = 18;
export const MAX_AMOUNT_DECIMALS = 18;

/**
 * Canonical money schema for a request body.
 *
 * Deliberately rejects, with a 400:
 *  - anything that is not a plain non-negative decimal (`1e18`, `+1`, ` 1 `,
 *    `1,5`, `NaN`, `Infinity` all fail) — these either mean nothing or mean
 *    something a float would silently misread;
 *  - zero and negative values;
 *  - more fractional digits than the asset can represent, which
 *    {@link toBaseUnits} would otherwise turn into an exception;
 *  - more integer digits than the `Decimal(36, 18)` column can hold.
 */
export function moneyString(
  options: {
    /** Human name of the asset, used in messages. */
    asset?: string;
    /** Maximum fractional digits allowed (defaults to the ledger's 18). */
    maxDecimals?: number;
    /** Maximum integer digits allowed (defaults to the ledger's 18). */
    maxIntegerDigits?: number;
  } = {},
): z.ZodString {
  const label = options.asset ? `${options.asset} amount` : "Amount";
  const maxDecimals = options.maxDecimals ?? MAX_AMOUNT_DECIMALS;
  const maxIntegerDigits = options.maxIntegerDigits ?? MAX_AMOUNT_INTEGER_DIGITS;

  return z
    .string()
    .regex(/^\d+(\.\d+)?$/, {
      message: `${label} must be a plain positive decimal number (digits, optionally one decimal point)`,
    })
    .refine((value) => isPositiveDecimalString(value), {
      message: `${label} must be greater than zero`,
    })
    .refine((value) => decimalPlacesOf(value) <= maxDecimals, {
      message: `${label} must have at most ${maxDecimals} decimal places`,
    })
    .refine((value) => {
      const [whole] = value.split(".");
      // Ignore leading zeros: "007" is 7, not a 3-digit number.
      return whole.replace(/^0+/, "").length <= maxIntegerDigits;
    }, {
      message: `${label} is too large (at most ${maxIntegerDigits} whole digits)`,
    });
}

/**
 * Runtime guard for amounts that arrive from outside a zod schema — provider
 * webhooks, queue payloads, reconciliation. Throws a 400-shaped error rather
 * than letting a bad string reach the chain adapter.
 */
export function assertValidAmount(
  amount: string,
  options: { asset?: string; maxDecimals?: number; maxIntegerDigits?: number } = {},
): void {
  const result = moneyString(options).safeParse(amount);
  if (!result.success) {
    throw Object.assign(new Error(result.error.issues[0]?.message ?? "Invalid amount"), { statusCode: 400 });
  }
}
