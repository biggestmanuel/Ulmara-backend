// In-memory verification-code store (no schema migration).
// Dev-mode only: requires DEV_VERIFICATION_MODE=true and a non-production
// NODE_ENV. Codes are single-use and expire after 10 minutes.
import { randomInt } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export type VerificationChannel = "email" | "phone";

const CODE_TTL_MS = 10 * 60 * 1000;

type StoredCode = { code: string; expiresAt: number };

const store = new Map<string, StoredCode>();

function storeKey(userId: string, channel: VerificationChannel) {
  return `${userId}:${channel}`;
}

function assertDevModeEnabled(channel: VerificationChannel) {
  if (!env.DEV_VERIFICATION_MODE || env.NODE_ENV === "production") {
    throw Object.assign(
      new Error(`${channel === "email" ? "Email" : "SMS"} verification provider is not configured`),
      { statusCode: 501 }
    );
  }
}

export function createVerificationCode(
  userId: string,
  channel: VerificationChannel,
  now: () => number = Date.now
): string {
  assertDevModeEnabled(channel);
  const code = randomInt(100000, 1000000).toString();
  store.set(storeKey(userId, channel), { code, expiresAt: now() + CODE_TTL_MS });
  logger.info({ userId, channel, code, expiresInMinutes: 10 }, "Development verification code");
  return code;
}

export function verifyVerificationCode(
  userId: string,
  channel: VerificationChannel,
  code: string,
  now: () => number = Date.now
): void {
  assertDevModeEnabled(channel);
  if (!/^\d{6}$/.test(code)) {
    throw Object.assign(new Error("Verification code must be 6 digits"), { statusCode: 400 });
  }

  const key = storeKey(userId, channel);
  const stored = store.get(key);
  if (!stored) {
    throw Object.assign(new Error("Invalid or expired verification code"), { statusCode: 400 });
  }
  if (stored.expiresAt < now()) {
    store.delete(key); // expired entry — clean up before rejecting
    throw Object.assign(new Error("Verification code has expired"), { statusCode: 400 });
  }
  if (stored.code !== code) {
    throw Object.assign(new Error("Invalid or expired verification code"), { statusCode: 400 });
  }
  store.delete(key); // single-use
}
