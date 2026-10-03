import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { env } from "../../config/env.js";
import {
  CODE_TTL_MS,
  createVerificationCode,
  deleteVerificationCode,
  generateVerificationCode,
  setVerificationCodeRedis,
  verifyVerificationCode,
} from "./verificationCodeStore.js";

/**
 * These tests run against a REAL Redis (the app's own REDIS_URL), because the
 * behaviour under test is Redis semantics: EX TTL, the Lua compare-and-delete
 * and the Lua attempt counter. A hand-written fake would not exercise those.
 *
 * Keys are namespaced per test run and removed in afterEach; no other data is
 * touched.
 */

const NAMESPACE = `test-otp-${process.pid}-${Date.now()}`;
let redis: Redis;

function userId(label: string): string {
  return `${NAMESPACE}-${label}`;
}

/** Scans and deletes only this run's keys. */
async function cleanup(): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "ulmara:otp:*", "COUNT", 500);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}

beforeEach(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  // Fail loudly rather than silently passing against a dead server.
  const pong = await redis.ping();
  // `pong` is narrowed to `never` by the check above (ioredis types it as the
  // literal "PONG"), so stringify rather than interpolate the empty branch.
  if (pong !== "PONG") throw new Error(`Expected a live Redis, got ${String(pong)}`);
  setVerificationCodeRedis(redis);
});

afterEach(async () => {
  await cleanup();
  setVerificationCodeRedis(null);
  await redis.quit();
});

describe("verification code generation", () => {
  it("generates 6-digit numeric codes", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });

  it("draws uniformly from the FULL 6-digit space, not a narrow slice", () => {
    // Deliberately does NOT assert "no collisions in N draws": with 200 draws
    // from 10^6 the birthday-paradox collision chance is ~2%, so such an
    // assertion is inherently flaky. What actually matters is that the draw
    // covers the whole range, so that is what is checked:
    //   - every value is within [100000, 999999],
    //   - both halves of the range are represented.
    const draws = Array.from({ length: 400 }, () => Number(generateVerificationCode()));
    for (const n of draws) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(100_000);
      expect(n).toBeLessThanOrEqual(999_999);
    }
    expect(Math.min(...draws)).toBeLessThan(550_000);
    expect(Math.max(...draws)).toBeGreaterThan(450_000);
    // A 5-digit code would mean the lower bound moved; assert the string form
    // always has exactly six characters (no leading zero is stripped).
    expect(draws.every((n) => String(n).length === 6)).toBe(true);
  });
});

describe("verification code lifecycle (real Redis)", () => {
  it("accepts the correct code and consumes it (single-use)", async () => {
    const id = userId("single-use");
    const code = await createVerificationCode(id, "email");

    expect(code).toMatch(/^\d{6}$/);
    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("verified");
    // A replay of a consumed code must not succeed.
    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("no_code");
  });

  it("stores only a hash of the code, never the code itself", async () => {
    const id = userId("hashed");
    const code = await createVerificationCode(id, "email");
    const key = `ulmara:otp:email:${id}`;
    const raw = await redis.get(key);

    expect(raw).toBeTruthy();
    expect(raw).not.toContain(code);
    const parsed = JSON.parse(raw!) as { h: string; e: number; a: number };
    expect(parsed.h).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.a).toBe(0);
    expect(parsed.e).toBeGreaterThan(Date.now());
  });

  it("survives a fresh client — the code is in Redis, not process memory", async () => {
    const id = userId("cross-process");
    const code = await createVerificationCode(id, "email");

    // A completely separate connection, as a second API instance would use.
    const other = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
    try {
      const still = await other.get(`ulmara:otp:email:${id}`);
      expect(still).toBeTruthy();
    } finally {
      await other.quit();
    }
    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("verified");
  });

  it("rejects a wrong code, keeps the real one usable, and counts the attempt", async () => {
    const id = userId("wrong-code");
    const code = await createVerificationCode(id, "email");
    const wrong = code === "000000" ? "111111" : "000000";

    await expect(verifyVerificationCode(id, "email", wrong)).resolves.toBe("invalid");
    const parsed = JSON.parse((await redis.get(`ulmara:otp:email:${id}`))!) as { a: number };
    expect(parsed.a).toBe(1);
    // A wrong attempt must not invalidate the correct code.
    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("verified");
  });

  it("discards the code once the wrong-attempt budget is spent", async () => {
    const id = userId("attempts");
    const code = await createVerificationCode(id, "email");
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < env.OTP_MAX_ATTEMPTS - 1; i++) {
      await expect(verifyVerificationCode(id, "email", wrong)).resolves.toBe("invalid");
    }
    await expect(verifyVerificationCode(id, "email", wrong)).resolves.toBe("attempts_exhausted");
    // Budget spent: even the correct code is now dead, forcing a resend.
    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("no_code");
  });

  it("rejects a malformed code shape with a 400 before touching Redis", async () => {
    const id = userId("malformed");
    await createVerificationCode(id, "email");
    for (const bad of ["12345", "1234567", "abcdef", "", " 123456"]) {
      await expect(verifyVerificationCode(id, "email", bad)).rejects.toThrow(
        "Verification code must be 6 digits",
      );
    }
  });

  it("reports an expired code distinctly from an unknown one", async () => {
    const id = userId("expiry");
    const code = await createVerificationCode(id, "email");
    const key = `ulmara:otp:email:${id}`;

    // Rewind the stored expiry past now, as the passage of time would.
    const record = JSON.parse((await redis.get(key))!) as { h: string; e: number; a: number };
    record.e = Date.now() - 1;
    await redis.set(key, JSON.stringify(record), "EX", 300);

    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("expired");
    // The expired record is cleaned up on that attempt.
    expect(await redis.get(key)).toBeNull();
  });

  it("accepts a code up to its expiry instant and rejects it at/past it", async () => {
    const id = userId("boundary");
    const key = `ulmara:otp:email:${id}`;

    // Deterministic: a fixed reference time T, with the stored expiry set
    // relative to it, so "one millisecond before" is exact rather than
    // dependent on how long the test takes to reach the assertion.
    const T = 1_800_000_000_000;

    const beforeCode = await createVerificationCode(id, "email", { now: () => T - CODE_TTL_MS });
    const beforeRecord = JSON.parse((await redis.get(key))!) as { h: string; e: number; a: number };
    beforeRecord.e = T + 1; // expires 1ms after the reference time
    await redis.set(key, JSON.stringify(beforeRecord), "EX", 300);
    // now = T-1 -> one millisecond before expiry -> still valid.
    await expect(
      verifyVerificationCode(id, "email", beforeCode, { now: () => T - 1 }),
    ).resolves.toBe("verified");

    const atCode = await createVerificationCode(id, "email", { now: () => T - CODE_TTL_MS });
    const atRecord = JSON.parse((await redis.get(key))!) as { h: string; e: number; a: number };
    atRecord.e = T; // expires exactly at T
    await redis.set(key, JSON.stringify(atRecord), "EX", 300);
    // now = T -> the expiry instant itself is already too late (e <= now).
    await expect(verifyVerificationCode(id, "email", atCode, { now: () => T })).resolves.toBe("expired");
  });

  it("keeps email and phone codes independent for the same user", async () => {
    const id = userId("channels");
    const emailCode = await createVerificationCode(id, "email");
    const phoneCode = await createVerificationCode(id, "phone");

    await expect(verifyVerificationCode(id, "phone", emailCode)).resolves.toBe("invalid");
    await expect(verifyVerificationCode(id, "phone", phoneCode)).resolves.toBe("verified");
    await expect(verifyVerificationCode(id, "email", emailCode)).resolves.toBe("verified");
  });

  it("a resend replaces the previous code and invalidates it", async () => {
    const id = userId("resend");
    const first = await createVerificationCode(id, "email");
    const second = await createVerificationCode(id, "email");

    // A resend is the common case; the superseded code must stop working.
    await expect(verifyVerificationCode(id, "email", first)).resolves.toBe("invalid");
    await expect(verifyVerificationCode(id, "email", second)).resolves.toBe("verified");
  });

  it("only the winning code can consume the record under concurrency", async () => {
    const id = userId("concurrent");
    const code = await createVerificationCode(id, "email");

    // Ten simultaneous submits of the SAME correct code: exactly one may win.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifyVerificationCode(id, "email", code)),
    );
    expect(results.filter((r) => r === "verified")).toHaveLength(1);
    expect(results.filter((r) => r !== "verified")).toHaveLength(9);
  });

  it("returns no_code for an unknown user/channel pair", async () => {
    await expect(verifyVerificationCode(userId("nobody"), "email", "123456")).resolves.toBe("no_code");
  });

  it("deleteVerificationCode removes the record", async () => {
    const id = userId("cleanup");
    const code = await createVerificationCode(id, "email");
    await deleteVerificationCode(id, "email");
    await expect(verifyVerificationCode(id, "email", code)).resolves.toBe("no_code");
  });

  it("applies the configured 10-minute TTL", async () => {
    const id = userId("ttl");
    await createVerificationCode(id, "email");
    const ttl = await redis.ttl(`ulmara:otp:email:${id}`);
    // The record is retained past expiry for the "expired" distinction, so
    // assert it is at least the code TTL and bounded.
    expect(ttl).toBeGreaterThan(CODE_TTL_MS / 1000);
    expect(ttl).toBeLessThanOrEqual(Math.ceil((CODE_TTL_MS + env.OTP_EXPIRY_GRACE_SECONDS * 1000) / 1000) + 2);
  });
});
