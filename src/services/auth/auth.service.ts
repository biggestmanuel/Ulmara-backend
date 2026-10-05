// Type declarations come from the dev-only @types/bcryptjs package
// (bcryptjs 2.x does not bundle its own).
import bcrypt from "bcryptjs";
import { sessionExpiry, signSessionToken } from "../../config/jwt.js";
import { prisma } from "../../config/database.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { HttpError } from "../../utils/apiResponse.js";
import { isEmailProviderConfigured, trySendEmail } from "../email/index.js";
import { ttlMinutes, verificationEmailBody, verificationEmailSubject } from "../email/templates.js";
import {
  createVerificationCode,
  verifyVerificationCode,
  type VerificationChannel,
} from "./verificationCodeStore.js";
import { pinLockoutService, lockedMessage } from "./pinLockout.service.js";
import { isUniqueConstraintViolation } from "../../utils/prismaError.js";

// Throwing is the service's way of signalling an expected failure with a
// client-readable message + status; controllers map it onto the response.
function fail(statusCode: number, message: string): never {
  throw new HttpError(statusCode, message);
}

const SALT_ROUNDS = 12;

function sanitizeUser<T extends { passwordHash: string; pinHash: string | null }>(user: T) {
  // `_`-prefixed so the deliberate omission of the credential columns is
  // explicit at the destructuring site rather than looking like a dead read.
  const { passwordHash: _passwordHash, pinHash: _pinHash, ...safe } = user;
  return safe;
}

/**
 * True only in an explicitly non-production run with DEV_VERIFICATION_MODE on.
 * In that case the code is additionally returned to the caller and written to
 * the log so a developer can complete the flow without an email inbox. The
 * production path never does either.
 */
function devVerificationEnabled(): boolean {
  return env.DEV_VERIFICATION_MODE && env.NODE_ENV !== "production";
}

/**
 * Issues a code and delivers it. Returns the raw code only in dev-verification
 * mode; otherwise the caller never learns it.
 *
 * A provider failure is surfaced as a 503 rather than swallowed: silently
 * "succeeding" would leave the user staring at a code that never arrived.
 */
async function issueAndDeliverCode(
  userId: string,
  email: string,
  channel: VerificationChannel,
): Promise<{ code: string; devCode?: string }> {
  const devMode = devVerificationEnabled();

  // In dev-verification mode the provider is bypassed ENTIRELY, not merely
  // tolerated. Previously the unconfigured-provider check ran first, so
  // DEV_VERIFICATION_MODE=true with no credentials still produced a 503 and no
  // devCode — the flag could not do the one thing it exists to do. The code is
  // still created and still expires on the normal TTL; only the external send
  // is skipped.
  if (!devMode && !isEmailProviderConfigured()) {
    logger.error(
      { event: "email_provider_unavailable", provider: env.EMAIL_PROVIDER, channel },
      "Cannot deliver a verification code: the configured email provider has no credentials",
    );
    fail(503, "We could not send a verification code right now. Please try again shortly.");
  }

  const code = await createVerificationCode(userId, channel);

  if (devMode) {
    // No external delivery is attempted at all. The code was created above, so
    // it expires on the normal TTL and still consumes the wrong-code budget.
    logger.warn(
      { event: "dev_verification_code", userId, channel, code },
      "DEV_VERIFICATION_MODE is on: provider delivery was SKIPPED, and the verification code is in this log line and in the response",
    );
    return { code, devCode: code };
  }

  const { html, text } = verificationEmailBody(code, ttlMinutes());
  const sent = await trySendEmail(email, verificationEmailSubject(code), html, text);
  if (!sent) {
    // Drop the code so a retry cannot be satisfied by a code that was never
    // delivered, and so the wrong-code budget starts clean.
    await createVerificationCode(userId, channel);
    fail(502, "We could not send a verification code right now. Please try again shortly.");
  }

  logger.info(
    { event: "verification_code_issued", userId, channel, expiresInMinutes: ttlMinutes() },
    "Verification code issued and dispatched",
  );

  return { code };
}

/** Maps a store outcome onto the client-facing message. */
function verificationFailure(outcome: string): never {
  switch (outcome) {
    case "expired":
      return fail(400, "Verification code has expired. Request a new one.");
    case "attempts_exhausted":
      return fail(429, "Too many incorrect attempts. Request a new verification code.");
    default:
      return fail(400, "Invalid or expired verification code");
  }
}

export const authService = {
  async signup(input: { email: string; phone?: string; password: string }, meta?: { userAgent?: string; ipAddress?: string }) {
    const email = input.email.trim().toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) fail(409, "An account with this email already exists. Try logging in instead.");

    if (input.phone) {
      const existingPhone = await prisma.user.findUnique({ where: { phone: input.phone } });
      if (existingPhone) {
        fail(409, "An account with this phone number already exists. Try logging in instead.");
      }
    }

    if (input.password.length < 8) {
      fail(400, "Password must be at least 8 characters");
    }

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    let user;
    try {
      user = await prisma.user.create({
        data: { email, phone: input.phone, passwordHash },
      });
    } catch (err) {
      // TOCTOU guard: a concurrent signup can claim the same email/phone between
      // the pre-checks above and this insert. Map the unique violation to a 409
      // instead of leaking a raw Prisma error as a 500.
      if (isUniqueConstraintViolation(err)) {
        fail(409, "An account with this email or phone already exists. Try logging in instead.");
      }
      throw err;
    }

    const token = signSessionToken(user.id);
    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt: sessionExpiry(),
        userAgent: meta?.userAgent,
        ipAddress: meta?.ipAddress,
      },
    });

    // Send the verification code. A delivery failure must not roll back the
    // signup (the account exists and the user can retry from "Resend code"),
    // but it is logged loudly and the code is omitted from the response.
    const emailDispatch = await issueAndDeliverCode(user.id, user.email, "email").catch((err: unknown) => {
      logger.error({ event: "signup_verification_email_failed", userId: user.id, err }, "Could not send the signup verification code");
      return null;
    });

    return {
      user: sanitizeUser(user),
      token,
      ...(emailDispatch?.devCode ? { devVerificationCodes: { email: emailDispatch.devCode } } : {}),
    };
  },

  async login(input: { email: string; password: string }, meta?: { userAgent?: string; ipAddress?: string }) {
    const user = await prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
    if (!user) fail(401, "Invalid email or password. Please check your details and try again.");

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) fail(401, "Invalid email or password. Please check your details and try again.");

    const token = signSessionToken(user.id);
    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt: sessionExpiry(),
        userAgent: meta?.userAgent,
        ipAddress: meta?.ipAddress,
      },
    });
    return { user: sanitizeUser(user), token };
  },

  async verifyEmail(input: { userId: string; code: string }) {
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) fail(404, "Account not found. Please sign up again.");
    if (user.emailVerified) return sanitizeUser(user); // idempotent
    const outcome = await verifyVerificationCode(input.userId, "email", input.code);
    if (outcome !== "verified") verificationFailure(outcome);
    const updated = await prisma.user.update({
      where: { id: input.userId },
      data: { emailVerified: true },
    });
    logger.info({ event: "email_verified", userId: input.userId }, "User email verified");
    return sanitizeUser(updated);
  },

  async verifyPhone(input: { userId: string; code: string }) {
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) fail(404, "Account not found. Please sign up again.");
    if (!user.phone) fail(400, "No phone number is linked to this account.");
    if (user.phoneVerified) return sanitizeUser(user); // idempotent
    const outcome = await verifyVerificationCode(input.userId, "phone", input.code);
    if (outcome !== "verified") verificationFailure(outcome);
    const updated = await prisma.user.update({
      where: { id: input.userId },
      data: { phoneVerified: true },
    });
    logger.info({ event: "phone_verified", userId: input.userId }, "User phone verified");
    return sanitizeUser(updated);
  },

  // Issues a fresh code for a channel. Used by the verify screens' "Resend
  // code" button. Rate-limiting lives on the route (@fastify/rate-limit).
  async resendVerificationCode(userId: string, channel: "email" | "phone") {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) fail(404, "Account not found. Please sign up again.");
    if (channel === "email" && user.emailVerified) {
      fail(400, "Your email is already verified.");
    }
    if (channel === "phone" && (!user.phone || user.phoneVerified)) {
      fail(400, "Your phone number is already verified.");
    }
    if (channel === "phone" && !user.phone) {
      fail(400, "No phone number is linked to this account.");
    }
    // Phone codes are not deliverable: no SMS provider is wired up yet, so
    // refuse explicitly rather than creating a code nobody can receive.
    if (channel === "phone") {
      fail(501, "SMS verification is not available yet. Verify your email instead.");
    }
    const dispatched = await issueAndDeliverCode(userId, user.email, "email");
    return { success: true, ...(dispatched.devCode ? { devCode: dispatched.devCode } : {}) };
  },

  // Always succeeds with the same shape so the endpoint can't be used to
  // discover which emails are registered. No email provider is wired up yet,
  // so nothing is actually sent — that lands with the production provider.
  async requestPasswordReset(input: { email: string }) {
    await prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
    return { success: true };
  },

  async setPin(userId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) {
      fail(400, "PIN must be 6 digits");
    }
    // A PIN may be set ONCE. Overwriting an existing one without proving you
    // know it removes the PIN's whole purpose as a second factor: a caller
    // holding only a session token could replace the victim's PIN with a value
    // they chose, then pass the transfer gate with it. That was reachable —
    // `setPin` used to hash and write unconditionally.
    //
    // `changePin` is the endpoint for replacing a PIN: it requires the current
    // one, is rate limited to 5/min, and its attempts count toward the shared
    // lockout. This one is the first-time path only, so the two no longer
    // overlap.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pinHash: true },
    });
    if (!user) {
      fail(404, "Account not found");
    }
    if (user.pinHash) {
      fail(409, "A PIN is already set for this account");
    }
    // Hashed after the cheap checks so a refused call costs no bcrypt work.
    const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
    // The write is a claim, not a plain update: `pinHash: null` sits in the
    // `where`, so of two concurrent first-time calls exactly one can match and
    // the other gets count 0. A read-then-write would let both through. This is
    // the same shape as the PENDING -> PROCESSING claim in
    // transactionService.broadcast.
    const claimed = await prisma.user.updateMany({
      where: { id: userId, pinHash: null },
      data: { pinHash },
    });
    if (claimed.count !== 1) {
      fail(409, "A PIN is already set for this account");
    }
    return { success: true };
  },

  // Login/account-entry PIN check. Shares the transfer PIN lockout: one
  // counter guards both gates because they verify the same User.pinHash, so
  // brute-forcing either must lock both. Non-revealing messages match the
  // transfer gate exactly. Attempts are attributed to the "login" gate in
  // the security log.
  async verifyPin(userId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) {
      fail(400, "PIN must be 6 digits");
    }
    const lock = await pinLockoutService.getLockState(userId);
    if (lock.locked && lock.until) {
      // Same security event the transfer gate emits on a cooldown attempt.
      pinLockoutService.logAttemptDuringLockout(userId, "login", lock.until);
      const minutes = Math.max(1, Math.ceil((lock.until.getTime() - Date.now()) / 60_000));
      fail(423, `Too many incorrect PIN attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) {
      fail(409, "No PIN set for this account");
    }
    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      const attempts = await pinLockoutService.recordFailure(userId, "login");
      if (attempts >= 5) fail(423, lockedMessage());
      fail(401, "Incorrect PIN. Try again.");
    }
    await pinLockoutService.reset(userId);
    return { valid: true };
  },

  async changePin(userId: string, currentPin: string, newPin: string) {
    if (!/^\d{6}$/.test(newPin)) {
      fail(400, "PIN must be 6 digits");
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) {
      fail(409, "No PIN set for this account");
    }
    // The current-PIN check verifies the same credential, so it counts toward
    // the shared counter too — otherwise changePin would be an untracked way
    // to brute-force the PIN. Delegates the compare + count/reset to the
    // lockout service's authorization primitive; attributed to "changePin"
    // in the security log.
    await pinLockoutService.assertPinAuthorized(userId, currentPin, "changePin");
    const pinHash = await bcrypt.hash(newPin, SALT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { pinHash } });
    return { success: true };
  },

  // Permanent account deletion. Prisma cascades sessions, wallets, payment
  // requests and ramp transactions (onDelete: Cascade); transactions and the
  // account-id row reference the user with RESTRICT, so they are detached/
  // cleared first inside a transaction. Mnemonics/keys never leave the
  // device, so wiping local storage on the client is enough for those.
  async deleteAccount(userId: string) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) fail(404, "Account not found");

    await prisma.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { userId } });
      // Transaction rows reference the user with RESTRICT and carry the
      // ledger history, so they are removed with the account here.
      await tx.$executeRaw`DELETE FROM "Transaction" WHERE "senderId" = ${userId}`;
      await tx.accountId.deleteMany({ where: { userId } });
      await tx.user.delete({ where: { id: userId } });
    });
    return { success: true };
  },

  async listSessions(userId: string, currentToken: string) {
    const sessions = await prisma.session.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    return sessions.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt,
      current: s.token === currentToken,
    }));
  },

  async revokeSession(userId: string, sessionId: string, currentToken: string) {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (session?.userId !== userId) {
      fail(404, "Session not found");
    }
    if (session.token === currentToken) {
      fail(400, "Cannot revoke your current session — use POST /api/auth/logout to sign out");
    }
    await prisma.session.delete({ where: { id: sessionId } });
    return { success: true };
  },

  /**
   * End the caller's OWN session, and only that one.
   *
   * This route existed nowhere, and that was a security hole rather than a
   * missing convenience. The client's logout is purely local — it wipes the
   * token from the device's keystore — so nothing ever told the server the
   * session was over. The `Session` row survived, and because `requireAuth`
   * treats the row as the source of truth, the token stayed valid for its full
   * `JWT_EXPIRES_IN` (7 days by default) after the user believed they had
   * signed out. Measured on the live server: after a local-only logout the same
   * token still answered 200 on /api/account/me, /api/transaction and
   * /api/contact, and still created a payment request (201).
   *
   * Transfers were not reachable with it — the PIN gate is independent of the
   * session, and a PIN cannot be replaced through a session token alone — but
   * balances, contacts and payment requests were all readable and creatable for
   * a week from a token the user believed was dead. That is the window a lost or
   * wiped phone actually leaves behind.
   *
   * `deleteAccount` (`DELETE /api/auth/me`) was the only server-side way to kill
   * a session, and it deletes the user. Signing out must not require destroying
   * the account, so this is the missing third option between "revoke another
   * device" and "delete everything".
   *
   * Scoped to the one session on purpose: logging out on a phone must not sign
   * the user out of their other devices, which is what `revokeSession` is for.
   * Deleting by token rather than by id also means this needs no request body and
   * cannot be pointed at somebody else's session.
   *
   * Idempotent AT THE SERVICE LEVEL: a token with no row is a success, not an
   * error. End to end a second call answers 401, because `requireAuth` rejects
   * the now-dead token before this runs. That is the right answer for a logout —
   * it is what the client's own 401 handling expects, and it leaves the user
   * signed out either way — but it is worth stating, because "logout is
   * idempotent" is otherwise read as "you can call it twice and get 200 both
   * times", which is not what happens.
   */
  async logout(currentToken: string) {
    // Delete by token, not by userId: a broad delete would end every device.
    const { count } = await prisma.session.deleteMany({ where: { token: currentToken } });
    logger.info(
      { event: "session_ended", removed: count },
      count > 0 ? "Session ended by logout" : "Logout on an already-ended session",
    );
    return { success: true };
  },
};
