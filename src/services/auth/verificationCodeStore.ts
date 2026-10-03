import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getRedis } from "../../queues/redis.client.js";

/**
 * Redis-backed verification-code store.
 *
 * Codes live in Redis (not process memory) so they survive an API restart and
 * work identically across multiple API instances. The record is JSON:
 *
 *   { "h": "<hmac of the code>", "e": <expiry epoch ms>, "a": <wrong attempts> }
 *
 * The raw code is never written to Redis — only a keyed HMAC of it, so a Redis
 * dump cannot be replayed as a valid code. Comparison is constant-time.
 *
 * The record outlives the code itself by OTP_EXPIRY_GRACE_SECONDS so a late
 * submit can be told "expired" rather than the less actionable "invalid code";
 * Redis TTL does the eventual cleanup.
 */

export type VerificationChannel = "email" | "phone";

export const CODE_TTL_MS = env.OTP_TTL_SECONDS * 1000;
export const EXPIRY_GRACE_MS = env.OTP_EXPIRY_GRACE_SECONDS * 1000;
const RETENTION_TTL_SECONDS = Math.ceil((CODE_TTL_MS + EXPIRY_GRACE_MS) / 1000);

interface StoredRecord { h: string; e: number; a: number }

/** Minimal surface of ioredis used here, so tests can inject a double. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  ttl(key: string): Promise<number>;
}

function storeKey(userId: string, channel: VerificationChannel): string {
  return `ulmara:otp:${channel}:${userId}`;
}

/**
 * Pepper for the stored HMAC. Derived from the JWT secret so no new secret
 * has to be provisioned; a code captured from Redis is useless without it.
 */
function pepper(): string {
  return createHmac("sha256", "ulmara:otp:v1").update(env.JWT_SECRET).digest("hex");
}

function hashCode(code: string): string {
  return createHmac("sha256", pepper()).update(code).digest("hex");
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Consume-if-matching. Returns 1 on a successful claim (and deletes the
 * record), 0 when the stored hash no longer matches. Atomic so a resend that
 * lands mid-verify cannot be silently deleted by the older request.
 */
const CONSUME_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, decoded = pcall(cjson.decode, raw)
if not ok then redis.call('DEL', KEYS[1]); return 0 end
if decoded['h'] ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Record a wrong attempt against the still-live record.
 * Returns the new attempt count, or -1 when the budget is spent and the
 * record was deleted, or 0 when the record no longer matches (a resend won).
 */
const FAILURE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, decoded = pcall(cjson.decode, raw)
if not ok then redis.call('DEL', KEYS[1]); return 0 end
if decoded['h'] ~= ARGV[1] then return 0 end
local ttl = redis.call('TTL', KEYS[1])
if ttl <= 0 then redis.call('DEL', KEYS[1]); return 0 end
local attempts = (tonumber(decoded['a']) or 0) + 1
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return -1
end
decoded['a'] = attempts
redis.call('SET', KEYS[1], cjson.encode(decoded), 'EX', ttl)
return attempts
`;

let clientOverride: RedisLike | null = null;

/** Test seam: inject a Redis double (or a real client) for the store. */
export function setVerificationCodeRedis(client: RedisLike | null): void {
  clientOverride = client;
}

function client(): RedisLike {
  if (clientOverride) return clientOverride;
  return getRedis();
}

export function generateVerificationCode(): string {
  return randomInt(100_000, 1_000_000).toString();
}

/**
 * Issues a code for a channel, replacing any previous one. The raw code is
 * returned so the caller can put it in the email; only its HMAC is persisted.
 */
export async function createVerificationCode(
  userId: string,
  channel: VerificationChannel,
  options: { now?: () => number; code?: string } = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const code = options.code ?? generateVerificationCode();
  const record: StoredRecord = { h: hashCode(code), e: now() + CODE_TTL_MS, a: 0 };

  await client().set(storeKey(userId, channel), JSON.stringify(record), "EX", RETENTION_TTL_SECONDS);

  return code;
}

/** Explicit cleanup (account deletion, test teardown). */
export async function deleteVerificationCode(userId: string, channel: VerificationChannel): Promise<void> {
  await client().del(storeKey(userId, channel));
}

export type VerifyOutcome = "verified" | "invalid" | "expired" | "no_code" | "attempts_exhausted";

/**
 * Verifies and consumes a code. Never throws for expected failures — the
 * caller maps the outcome onto a response so a wrong code and an expired code
 * can be distinguished without leaking whether the account exists.
 */
export async function verifyVerificationCode(
  userId: string,
  channel: VerificationChannel,
  code: string,
  options: { now?: () => number } = {},
): Promise<VerifyOutcome> {
  const now = options.now ?? Date.now;

  if (!/^\d{6}$/.test(code)) {
    badRequest("Verification code must be 6 digits");
  }

  const key = storeKey(userId, channel);
  const redis = client();
  const raw = await redis.get(key);

  if (!raw) return "no_code";

  let record: StoredRecord;
  try {
    record = JSON.parse(raw) as StoredRecord;
  } catch {
    await redis.del(key);
    return "no_code";
  }

  if (typeof record?.e !== "number" || typeof record?.h !== "string") {
    await redis.del(key);
    return "no_code";
  }

  if (record.e <= now()) {
    // Expired: drop the record now rather than waiting out the grace window.
    await redis.del(key);
    return "expired";
  }

  if (!safeEquals(record.h, hashCode(code))) {
    const attempts = await redis.eval(FAILURE_SCRIPT, 1, key, record.h, env.OTP_MAX_ATTEMPTS);
    const count = typeof attempts === "number" ? attempts : Number(attempts);
    if (count === -1) {
      logger.warn(
        { event: "otp_attempts_exhausted", channel, userId },
        "Verification code discarded after too many incorrect attempts",
      );
      return "attempts_exhausted";
    }
    if (count === 0) {
      // The record changed underneath us (a resend replaced it): treat as
      // invalid rather than letting the newer code be deleted.
      return "invalid";
    }
    return "invalid";
  }

  const consumed = await redis.eval(CONSUME_SCRIPT, 1, key, record.h);
  return Number(consumed) === 1 ? "verified" : "invalid";
}

/**
 * Non-sensitive introspection: remaining seconds for a live code, or null
 * when there is nothing stored. Never returns the code or its hash.
 */
export async function verificationCodeTtlSeconds(userId: string, channel: VerificationChannel): Promise<number | null> {
  const ttl = await client().ttl(storeKey(userId, channel));
  return ttl >= 0 ? ttl : null;
}
