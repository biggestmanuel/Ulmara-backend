import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "./env.js";

/**
 * Session-token signing/verification with zero-downtime key rotation.
 *
 * Three-key lifecycle:
 *   1. Steady state          -> JWT_SECRET only.
 *   2. Rotation window       -> JWT_SECRET (current, signs new tokens) plus
 *                               JWT_PREVIOUS_SECRET (retiring, verifies old
 *                               tokens only).
 *   3. Retired              -> JWT_PREVIOUS_SECRET cleared. Tokens signed
 *                               with it are rejected outright, so anyone
 *                               holding one is forced to re-authenticate.
 *
 * A previous key is honoured ONLY while JWT_PREVIOUS_SECRET_RETIRE_AT is in
 * the future. If the variable is absent or already past, the previous key is
 * not consulted at all, so a forgotten variable cannot silently keep a
 * compromised key valid forever.
 */

export interface SessionClaims extends JwtPayload {
  sub: string;
}

export type VerifyFailure = "malformed" | "expired" | "revoked_key" | "unknown_user" | "not_configured";

export type VerifyResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: VerifyFailure };

function previousSecretActive(): boolean {
  if (!env.JWT_PREVIOUS_SECRET) return false;
  if (!env.JWT_PREVIOUS_SECRET_RETIRE_AT) return false;
  const retireAt = new Date(env.JWT_PREVIOUS_SECRET_RETIRE_AT);
  if (Number.isNaN(retireAt.getTime())) return false;
  return retireAt.getTime() > Date.now();
}

/** Diagnostics for the operational endpoints — never returns secret material. */
export function jwtRotationState(): {
  currentKeyConfigured: boolean;
  previousKeyConfigured: boolean;
  previousKeyActive: boolean;
  previousKeyRetiresAt: string | null;
  millisecondsUntilPreviousKeyRetires: number | null;
} {
  const active = previousSecretActive();
  return {
    currentKeyConfigured: Boolean(env.JWT_SECRET),
    previousKeyConfigured: Boolean(env.JWT_PREVIOUS_SECRET),
    previousKeyActive: active,
    previousKeyRetiresAt: env.JWT_PREVIOUS_SECRET_RETIRE_AT ?? null,
    millisecondsUntilPreviousKeyRetires: active && env.JWT_PREVIOUS_SECRET_RETIRE_AT
      ? new Date(env.JWT_PREVIOUS_SECRET_RETIRE_AT).getTime() - Date.now()
      : null,
  };
}

export function signSessionToken(userId: string): string {
  // Always the CURRENT key — a token minted during a rotation window must not
  // be signed with the secret that is about to be retired.
  //
  // `jti` is a per-token unique id. Without it, two tokens signed for the same
  // user inside the same clock second were BYTE-IDENTICAL: `sub` matches and
  // `iat` has one-second resolution. auth.service.login then inserted the
  // second one into a table with a unique index on `token`, and the insert threw
  // P2002, which the controller turned into a bare 500. A double-tapped login
  // button was enough. The random jti makes each token distinct while leaving
  // `sub` — the only claim anything reads — untouched, so tokens already
  // issued keep verifying exactly as before.
  return jwt.sign({ sub: userId, jti: randomUUID() }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

export function verifySessionToken(token: string): VerifyResult {
  let payload: string | JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TokenExpiredError") return { ok: false, reason: "expired" };
    if (previousSecretActive()) {
      // Fall back to the retiring key, but only inside its window: a token
      // that the current key rejects may still be a legitimately-issued
      // pre-rotation token.
      try {
        payload = jwt.verify(token, env.JWT_PREVIOUS_SECRET!);
      } catch (prevErr) {
        return {
          ok: false,
          reason: (prevErr as { name?: string })?.name === "TokenExpiredError" ? "expired" : "malformed",
        };
      }
    } else {
      return { ok: false, reason: "malformed" };
    }
  }

  if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, claims: payload as SessionClaims };
}

export function sessionExpiry(): Date {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_EXPIRES_IN);
  if (!match) return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const value = Number(match[1]);
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() + value * multipliers[match[2] as keyof typeof multipliers]);
}
