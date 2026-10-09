import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

// env is a live object; mutate the three fields rotation depends on so the real
// signing/verification code (not a mock) is under test.
const { envState } = vi.hoisted(() => ({
  envState: {
    env: {
      JWT_SECRET: "current-secret-value-that-is-long-enough-x",
      JWT_PREVIOUS_SECRET: undefined as string | undefined,
      JWT_PREVIOUS_SECRET_RETIRE_AT: undefined as string | undefined,
      JWT_EXPIRES_IN: "7d",
      NODE_ENV: "test",
    },
  },
}));

vi.mock("../config/env.js", () => ({ env: envState.env }));

import { jwtRotationState, sessionExpiry, signSessionToken, verifySessionToken } from "./jwt.js";

const CURRENT = "current-secret-value-that-is-long-enough-x";
const PREVIOUS = "previous-secret-value-that-is-long-enough-y";

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

beforeEach(() => {
  envState.env.JWT_SECRET = CURRENT;
  envState.env.JWT_PREVIOUS_SECRET = undefined;
  envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signSessionToken", () => {
  it("signs with the CURRENT secret", () => {
    const token = signSessionToken("user-1");
    // Decoded with the current secret -> verifies.
    expect(jwt.verify(token, CURRENT)).toMatchObject({ sub: "user-1" });
    // Decoded with any other secret -> does not.
    expect(() => jwt.verify(token, "some-other-secret")).toThrow();
  });

  it("carries the userId as the subject and an expiry", () => {
    const decoded = jwt.decode(signSessionToken("user-42")) as { sub: string; exp: number; iat: number };
    expect(decoded.sub).toBe("user-42");
    expect(decoded.exp).toBeGreaterThan(decoded.iat);
  });

  it("never signs with the previous secret during a rotation window", () => {
    envState.env.JWT_PREVIOUS_SECRET = PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(3_600_000);
    const token = signSessionToken("user-1");
    // If it had been signed with PREVIOUS, this would pass.
    expect(() => jwt.verify(token, PREVIOUS)).toThrow();
    expect(jwt.verify(token, CURRENT)).toBeTruthy();
  });

  // ---------------------------------------------------------------------
  // B6: `Session.token` is @unique, and two tokens minted for the same user
  // within the same clock second used to be BYTE-IDENTICAL — `sub` matched and
  // `iat` has one-second resolution. The second insert raised P2002 and the
  // controller turned it into a bare 500, so a double-tapped login button
  // produced a server error. The random `jti` makes every token distinct.
  // ---------------------------------------------------------------------
  it("gives two tokens for the SAME user in the SAME second different values", () => {
    const a = signSessionToken("user-1");
    const b = signSessionToken("user-1");
    expect(a).not.toBe(b);
  });

  it("stays distinct even when iat is frozen to the same second", () => {
    // Freezing the clock is what makes this a real regression test: without the
    // jti, identical sub + identical iat + identical secret + identical payload
    // is a byte-for-byte identical signature.
    vi.useFakeTimers();
    try {
      const a = signSessionToken("user-1");
      const b = signSessionToken("user-1");
      expect(a).not.toBe(b);
      const decodedA = jwt.decode(a) as { sub: string; iat: number; jti: string };
      const decodedB = jwt.decode(b) as { sub: string; iat: number; jti: string };
      expect(decodedA.iat).toBe(decodedB.iat);
      expect(decodedA.sub).toBe(decodedB.sub);
      expect(decodedA.jti).not.toBe(decodedB.jti);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a unique jti on every token", () => {
    const jtis = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const decoded = jwt.decode(signSessionToken("user-1")) as { jti?: string };
      expect(typeof decoded.jti).toBe("string");
      expect(decoded.jti).not.toBe("");
      jtis.add(decoded.jti!);
    }
    expect(jtis.size).toBe(100);
  });

  it("keeps every previously issued token working", () => {
    // A token minted before the change carries no jti at all. Verification must
    // not have started requiring one, or this change would log everyone out.
    const legacy = jwt.sign({ sub: "user-1" }, CURRENT, { expiresIn: "7d" });
    const result = verifySessionToken(legacy);
    expect(result.ok).toBe(true);
  });

  it("verifies a freshly minted token as before", () => {
    const token = signSessionToken("user-1");
    const result = verifySessionToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("user-1");
  });

  it("still rejects a token signed with an unknown secret", () => {
    const forged = jwt.sign({ sub: "user-1", jti: "attacker-chosen" }, "wrong-secret");
    expect(verifySessionToken(forged).ok).toBe(false);
  });
});

describe("verifySessionToken in steady state", () => {
  it("verifies a token signed with the current secret", () => {
    const result = verifySessionToken(signSessionToken("user-1"));
    expect(result).toEqual({ ok: true, claims: expect.objectContaining({ sub: "user-1" }) });
  });

  it("rejects a token signed with an unknown secret", () => {
    const forged = jwt.sign({ sub: "attacker" }, "not-our-secret-at-all-really-xx");
    expect(verifySessionToken(forged)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a structurally invalid token", () => {
    expect(verifySessionToken("not-a-jwt")).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports an expired token distinctly from a malformed one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const token = signSessionToken("user-1");
    vi.setSystemTime(new Date("2030-01-30T00:00:00Z")); // past 7d
    expect(verifySessionToken(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token with no subject", () => {
    const noSub = jwt.sign({ role: "user" }, CURRENT);
    expect(verifySessionToken(noSub)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("verifySessionToken during a rotation window", () => {
  beforeEach(() => {
    envState.env.JWT_PREVIOUS_SECRET = PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(3_600_000); // retires in 1h
  });

  it("still accepts a token signed with the previous secret", () => {
    const legacy = jwt.sign({ sub: "user-1" }, PREVIOUS, { expiresIn: "7d" });
    expect(verifySessionToken(legacy)).toEqual({ ok: true, claims: expect.objectContaining({ sub: "user-1" }) });
  });

  it("accepts a token signed with the current secret", () => {
    expect(verifySessionToken(signSessionToken("user-1")).ok).toBe(true);
  });

  it("still rejects a token signed with a third, unknown secret", () => {
    const forged = jwt.sign({ sub: "attacker" }, "totally-unrelated-secret-value");
    expect(verifySessionToken(forged)).toEqual({ ok: false, reason: "malformed" });
  });

  it("reports an old token that has ALSO expired as expired, not malformed", () => {
    // The rotation window must still be OPEN for this distinction to apply,
    // so the window is set after the fake clock moves and outlasts the token.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(24 * 3_600_000);

    const legacy = jwt.sign({ sub: "user-1" }, PREVIOUS, { expiresIn: "1h" });
    vi.setSystemTime(new Date("2030-01-01T05:00:00Z"));
    // The token's own exp is past, so this is "expired" even though the
    // rotation window is still open and the token is signed with a valid key.
    expect(verifySessionToken(legacy)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("retiring the previous secret", () => {
  it("rejects previous-secret tokens once the retire time has passed", () => {
    envState.env.JWT_PREVIOUS_SECRET = PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(-1000); // already passed
    const legacy = jwt.sign({ sub: "user-1" }, PREVIOUS, { expiresIn: "7d" });
    // The window closed: the old key is no longer consulted at all.
    expect(verifySessionToken(legacy)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects previous-secret tokens when PREVIOUS is cleared but RETIRE_AT remains", () => {
    envState.env.JWT_PREVIOUS_SECRET = undefined;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(3_600_000);
    const legacy = jwt.sign({ sub: "user-1" }, PREVIOUS, { expiresIn: "7d" });
    // A forgotten JWT_PREVIOUS_SECRET must NOT keep a retired key alive.
    expect(verifySessionToken(legacy)).toEqual({ ok: false, reason: "malformed" });
  });

  it("ignores PREVIOUS when RETIRE_AT is absent (no window defined)", () => {
    envState.env.JWT_PREVIOUS_SECRET = PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = undefined;
    const legacy = jwt.sign({ sub: "user-1" }, PREVIOUS, { expiresIn: "7d" });
    expect(verifySessionToken(legacy)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a token signed with the now-CURRENT key being rotated away", () => {
    // End-to-end shape of a rotation:
    //   1. old key signs  -> 2. promote to PREVIOUS + set new CURRENT
    //   3. old tokens keep working inside the window
    //   4. window closes  -> 5. old tokens are rejected
    const OLD = "the-very-first-secret-value-aaaaaaaaa";
    const OLD_PREVIOUS = "the-very-second-secret-value-bbbb";
    envState.env.JWT_SECRET = OLD;
    const step1 = signSessionToken("user-1");

    // Step 2: rotate.
    envState.env.JWT_SECRET = OLD_PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET = OLD;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(60_000);
    const step2 = signSessionToken("user-1");

    // Step 3: both generations are honoured.
    expect(verifySessionToken(step1).ok).toBe(true);
    expect(verifySessionToken(step2).ok).toBe(true);

    // Step 4/5: the window closes.
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(-1);
    expect(verifySessionToken(step1)).toEqual({ ok: false, reason: "malformed" });
    // The current generation is unaffected by the old key's retirement.
    expect(verifySessionToken(step2).ok).toBe(true);
  });
});

describe("jwtRotationState (never returns secret material)", () => {
  it("reports steady state", () => {
    expect(jwtRotationState()).toMatchObject({
      currentKeyConfigured: true,
      previousKeyConfigured: false,
      previousKeyActive: false,
      previousKeyRetiresAt: null,
      millisecondsUntilPreviousKeyRetires: null,
    });
  });

  it("reports an active window with the remaining time", () => {
    envState.env.JWT_PREVIOUS_SECRET = PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(3_600_000);
    const state = jwtRotationState();
    expect(state.previousKeyConfigured).toBe(true);
    expect(state.previousKeyActive).toBe(true);
    expect(state.millisecondsUntilPreviousKeyRetires).toBeGreaterThan(3_500_000);
    // The secrets themselves must never appear.
    expect(JSON.stringify(state)).not.toContain(CURRENT);
    expect(JSON.stringify(state)).not.toContain(PREVIOUS);
  });

  it("reports a configured-but-inactive previous key", () => {
    envState.env.JWT_PREVIOUS_SECRET = PREVIOUS;
    envState.env.JWT_PREVIOUS_SECRET_RETIRE_AT = isoIn(-1);
    expect(jwtRotationState()).toMatchObject({ previousKeyConfigured: true, previousKeyActive: false });
  });
});

describe("sessionExpiry", () => {
  it("derives the expiry from JWT_EXPIRES_IN", () => {
    envState.env.JWT_EXPIRES_IN = "2h";
    const expiry = sessionExpiry();
    const delta = expiry.getTime() - Date.now();
    expect(delta).toBeGreaterThan(7_100_000);
    expect(delta).toBeLessThanOrEqual(7_200_000);
  });

  it("falls back to 7 days for an unparseable duration", () => {
    envState.env.JWT_EXPIRES_IN = "not-a-duration";
    const delta = sessionExpiry().getTime() - Date.now();
    expect(delta).toBeGreaterThan(6 * 86_400_000);
    expect(delta).toBeLessThanOrEqual(7 * 86_400_000);
  });
});
