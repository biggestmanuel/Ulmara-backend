import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { env } from "../../config/env.js";
import {
  createVerificationCode,
  verifyVerificationCode,
} from "./verificationCodeStore.js";

// In-memory store shared per-process; unique ids keep tests isolated.
let userSeq = 0;
function freshUser() {
  return `test-user-${++userSeq}-${Date.now()}`;
}

describe("verificationCodeStore", () => {
  beforeEach(() => {
    vi.stubEnv("DEV_VERIFICATION_MODE", "true");
    vi.stubEnv("NODE_ENV", "development");
    // env is parsed once at import time; mirror the dev-mode shape the tests need.
    (env as { DEV_VERIFICATION_MODE: boolean }).DEV_VERIFICATION_MODE = true;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("creates a 6-digit numeric code", () => {
    const userId = freshUser();
    const code = createVerificationCode(userId, "email");

    expect(code).toMatch(/^\d{6}$/);
  });

  it("generates different codes across calls", () => {
    const userId = freshUser();
    const codes = new Set(
      Array.from({ length: 10 }, () => {
        const c = createVerificationCode(freshUser(), "email");
        void userId;
        return c;
      })
    );

    expect(codes.size).toBeGreaterThan(1);
  });

  it("accepts the correct code within the TTL", () => {
    const userId = freshUser();
    const code = createVerificationCode(userId, "email");

    expect(() => verifyVerificationCode(userId, "email", code)).not.toThrow();
  });

  it("rejects a wrong code and keeps the original valid", () => {
    const userId = freshUser();
    const code = createVerificationCode(userId, "email");

    expect(() => verifyVerificationCode(userId, "email", "000000".padEnd(6, "0"))).toThrow(
      "Invalid or expired verification code"
    );
    // Original code still usable after a failed attempt.
    expect(() => verifyVerificationCode(userId, "email", code)).not.toThrow();
  });

  it("rejects codes that are not exactly 6 digits", () => {
    const userId = freshUser();
    createVerificationCode(userId, "email");

    for (const bad of ["12345", "1234567", "abcdef", "12 456", ""]) {
      expect(() => verifyVerificationCode(userId, "email", bad)).toThrow(
        "Verification code must be 6 digits"
      );
    }
  });

  it("rejects an unknown userId/channel combination", () => {
    expect(() => verifyVerificationCode(freshUser(), "email", "123456")).toThrow(
      "Invalid or expired verification code"
    );
  });

  it("rejects an expired code and cleans up the entry", () => {
    const userId = freshUser();
    let now = 1_000_000;
    const clock = () => now;

    const emailCode = createVerificationCode(userId, "email", clock);
    const phoneCode = createVerificationCode(userId, "phone", clock);

    now += 10 * 60 * 1000; // exactly at the TTL boundary: still valid
    expect(() => verifyVerificationCode(userId, "email", emailCode, clock)).not.toThrow();

    now += 1; // one tick past 10 minutes: expired
    expect(() => verifyVerificationCode(userId, "phone", phoneCode, clock)).toThrow(
      "Verification code has expired"
    );

    // Entry was deleted, so the stored code is gone even after rewinding time.
    now -= 10 * 60 * 1000 + 1;
    expect(() => verifyVerificationCode(userId, "phone", phoneCode, clock)).toThrow(
      "Invalid or expired verification code"
    );
  });

  it("accepts a code one millisecond before expiry", () => {
    const userId = freshUser();
    let now = 5_000_000;
    const clock = () => now;

    const code = createVerificationCode(userId, "phone", clock);

    now += 10 * 60 * 1000 - 1;
    expect(() => verifyVerificationCode(userId, "phone", code, clock)).not.toThrow();
  });

  it("allows each channel to hold an independent code for the same user", () => {
    const userId = freshUser();
    const emailCode = createVerificationCode(userId, "email");
    const phoneCode = createVerificationCode(userId, "phone");

    expect(() => verifyVerificationCode(userId, "email", emailCode)).not.toThrow();
    expect(() => verifyVerificationCode(userId, "phone", phoneCode)).not.toThrow();
    // Codes are not interchangeable across channels.
    expect(() => verifyVerificationCode(userId, "phone", emailCode)).toThrow();
  });

  it("is single-use: a consumed code cannot be replayed", () => {
    const userId = freshUser();
    const code = createVerificationCode(userId, "email");

    expect(() => verifyVerificationCode(userId, "email", code)).not.toThrow();
    expect(() => verifyVerificationCode(userId, "email", code)).toThrow(
      "Invalid or expired verification code"
    );
  });

  it("refuses to issue or verify codes when dev mode is disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    (env as { DEV_VERIFICATION_MODE: boolean }).DEV_VERIFICATION_MODE = false;

    const userId = freshUser();
    expect(() => createVerificationCode(userId, "email")).toThrow(
      "Email verification provider is not configured"
    );
    expect(() => verifyVerificationCode(userId, "email", "123456")).toThrow(
      "Email verification provider is not configured"
    );
  });
});
