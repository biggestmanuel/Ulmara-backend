import { describe, expect, it } from "vitest";
import {
  assertValidAmount,
  decimalPlacesOf,
  fromBaseUnits,
  isPositiveDecimalString,
  moneyString,
  toBaseUnits,
} from "./money.js";

/**
 * Money precision regression suite.
 *
 * Every case here corresponds to a way the previous float-based arithmetic in
 * the SOL / TRX / TON adapters could lose or invent money, or a way a
 * malformed amount could reach the database or a chain call. They are written
 * as properties of the shared conversion module rather than of one adapter, so
 * a new adapter that uses it inherits the guarantee.
 */

/** Independent, obviously-correct reference: pure integer string maths. */
function referenceBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".");
  expect(frac.length).toBeLessThanOrEqual(decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

describe("toBaseUnits (display string -> base units)", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(toBaseUnits("1", 9)).toBe(1_000_000_000n);
    expect(toBaseUnits("0.5", 9)).toBe(500_000_000n);
    expect(toBaseUnits("0.000000001", 9)).toBe(1n);
    expect(toBaseUnits("21000000.000000001", 9)).toBe(21_000_000_000_000_001n);
  });

  it("handles zero and the smallest representable value", () => {
    expect(toBaseUnits("0", 9)).toBe(0n);
    expect(toBaseUnits("0.000000001", 9)).toBe(1n);
  });

  it("handles the largest amount a 64-bit chain can move", () => {
    // 2^63-1 wei; the conversion must not go through a float.
    const maxU64 = "18446744073709551615";
    expect(toBaseUnits(maxU64, 0)).toBe(18_446_744_073_709_551_615n);
  });

  it("matches the exact reference on values that broke the float maths", () => {
    // These three were measured as WRONG under `Math.round(Number(x) * 10**d)`.
    const cases: [amount: string, decimals: number][] = [
      ["707273841233.73715227", 9],   // float lost 47,730 lamports
      ["52060961747.611969", 6],      // float was off by one sun
      ["786554992565.017438", 6],
      ["419268965916.8113", 9],
    ];
    for (const [amount, decimals] of cases) {
      expect(toBaseUnits(amount, decimals)).toBe(referenceBaseUnits(amount, decimals));
    }
  });

  it("agrees with the reference across a wide sweep of 18-decimal amounts", () => {
    let seed = 987654321;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const whole = String(Math.floor(rand() * 1e12));
      const fracDigits = Math.floor(rand() * 19);
      let frac = "";
      for (let d = 0; d < fracDigits; d++) frac += String(Math.floor(rand() * 10));
      const amount = frac ? `${whole}.${frac}` : whole;
      expect(toBaseUnits(amount, 18), amount).toBe(referenceBaseUnits(amount, 18));
    }
  });

  it("rejects more decimal places than the asset supports", () => {
    expect(() => toBaseUnits("0.0000000001", 9)).toThrow();
    expect(() => toBaseUnits("1.2345678", 6)).toThrow();
  });

  it("rejects exponent notation and other non-plain-decimal input", () => {
    expect(() => toBaseUnits("1e18", 18)).toThrow();
    expect(() => toBaseUnits("+1", 18)).toThrow();
    expect(() => toBaseUnits(" 1", 18)).toThrow();
  });
});

describe("fromBaseUnits (base units -> display string)", () => {
  it("renders exact values, including ones a float cannot represent", () => {
    expect(fromBaseUnits(21_000_000_000_000_001n, 9)).toBe("21000000.000000001");
    expect(fromBaseUnits(123_456_789_123_456_789n, 9)).toBe("123456789.123456789");
  });

  it("renders zero and whole numbers without a trailing point or a bare .0", () => {
    // `ethers.formatUnits` renders these as "0.0" and "21.0"; the previous
    // float-based code paths produced "0" and "21", and that is the contract
    // clients see, so the all-zero fraction is dropped.
    expect(fromBaseUnits(0n, 9)).toBe("0");
    expect(fromBaseUnits(0n, 6)).toBe("0");
    expect(fromBaseUnits(21_000_000_000n, 9)).toBe("21");
    expect(fromBaseUnits(1_000_000_000n, 9)).toBe("1");
    expect(fromBaseUnits(100n, 6)).toBe("0.0001");
  });

  it("does not lose the trailing digits the old float division dropped", () => {
    const base = 123_456_789_123_456_789n;
    // The float path produced "123456789.12345679" here.
    expect(fromBaseUnits(base, 9)).not.toBe("123456789.12345679");
    expect(fromBaseUnits(base, 9)).toBe("123456789.123456789");
  });

  it("round-trips every value it produces", () => {
    for (const [amount, decimals] of [
      ["0.000000001", 9],
      ["1.5", 9],
      ["21000000.000000001", 9],
      ["12345678.123456", 6],
      ["999999999.999999999", 9],
    ] as [string, number][]) {
      const base = toBaseUnits(amount, decimals);
      expect(toBaseUnits(fromBaseUnits(base, decimals), decimals)).toBe(base);
    }
  });

  it("is exact at the 6-decimal and 18-decimal scales alike", () => {
    expect(fromBaseUnits(1n, 6)).toBe("0.000001");
    expect(fromBaseUnits(1n, 18)).toBe("0.000000000000000001");
  });
});

describe("decimalPlacesOf / isPositiveDecimalString", () => {
  it("counts decimal places", () => {
    expect(decimalPlacesOf("1")).toBe(0);
    expect(decimalPlacesOf("1.5")).toBe(1);
    expect(decimalPlacesOf("1.500000000000000001")).toBe(18);
  });

  it("detects strictly positive values without a float", () => {
    expect(isPositiveDecimalString("1")).toBe(true);
    expect(isPositiveDecimalString("0.000000000000000001")).toBe(true);
    expect(isPositiveDecimalString("0")).toBe(false);
    expect(isPositiveDecimalString("0.00")).toBe(false);
    expect(isPositiveDecimalString("0.000")).toBe(false);
    expect(isPositiveDecimalString("")).toBe(false);
    expect(isPositiveDecimalString("1e18")).toBe(false);
    expect(isPositiveDecimalString("-1")).toBe(false);
  });
});

describe("moneyString (request validation)", () => {
  const schema = moneyString();

  it("accepts the extreme but valid shapes", () => {
    expect(schema.safeParse("0.000000000000000001").success).toBe(true);
    expect(schema.safeParse("1").success).toBe(true);
    expect(schema.safeParse("999999999999999999.999999999999999999").success).toBe(true);
  });

  it("rejects zero, including every way of writing it", () => {
    for (const zero of ["0", "0.0", "0.00", "0.000000000000000000"]) {
      expect(schema.safeParse(zero).success, zero).toBe(false);
    }
  });

  it("rejects more fractional digits than the ledger stores", () => {
    const r = schema.safeParse("1.0000000000000000001"); // 19 decimals
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/at most 18 decimal places/);
  });

  it("accepts exactly 18 decimal places", () => {
    expect(schema.safeParse("1.000000000000000001").success).toBe(true);
  });

  it("rejects more integer digits than Decimal(36, 18) can hold", () => {
    const r = schema.safeParse("1234567890123456789.5"); // 19 whole digits
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/too large/);
  });

  it("does not count leading zeros towards the digit budget", () => {
    expect(schema.safeParse("00000000000000000001").success).toBe(true);
  });

  it("rejects everything that is not a plain decimal string", () => {
    for (const bad of ["1e18", "+1", "-1", " 1", "1 ", "1,5", "abc", "NaN", "Infinity", "0x10", "1.2.3", ""]) {
      expect(schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("rejects a non-string outright", () => {
    expect(schema.safeParse(1).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("honours a per-asset decimal budget", () => {
    const usdc = moneyString({ asset: "USDC", maxDecimals: 6 });
    expect(usdc.safeParse("1.123456").success).toBe(true);
    const r = usdc.safeParse("1.1234567");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/USDC amount must have at most 6 decimal places/);
  });
});

describe("assertValidAmount (service-layer guard)", () => {
  it("passes a valid amount", () => {
    expect(() => assertValidAmount("1.5")).not.toThrow();
  });

  it("throws a 400-shaped error for an invalid one", () => {
    try {
      assertValidAmount("0");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});
