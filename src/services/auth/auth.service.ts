// bcryptjs does not currently ship TypeScript declarations.
// @ts-expect-error — the package exposes the required runtime API.
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { prisma } from "../../config/database.js";
import { env } from "../../config/env.js";
import { HttpError } from "../../utils/apiResponse.js";
import {
  createVerificationCode,
  verifyVerificationCode,
} from "./verificationCodeStore.js";

// Throwing is the service's way of signalling an expected failure with a
// client-readable message + status; controllers map it onto the response.
function fail(statusCode: number, message: string): never {
  throw new HttpError(statusCode, message);
}

const SALT_ROUNDS = 12;

function signSession(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

function sessionExpiry(): Date {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_EXPIRES_IN);
  if (!match) return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const value = Number(match[1]);
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() + value * multipliers[match[2] as keyof typeof multipliers]);
}

function sanitizeUser<T extends { passwordHash: string; pinHash: string | null }>(user: T) {
  const { passwordHash, pinHash, ...safe } = user;
  return safe;
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
      if ((err as { code?: string })?.code === "P2002") {
        fail(409, "An account with this email or phone already exists. Try logging in instead.");
      }
      throw err;
    }

    const token = signSession(user.id);
    await prisma.session.create({
      data: {
        userId: user.id,
        token,
        expiresAt: sessionExpiry(),
        userAgent: meta?.userAgent,
        ipAddress: meta?.ipAddress,
      },
    });

    const devVerificationCodes = env.DEV_VERIFICATION_MODE && env.NODE_ENV !== "production"
      ? {
          email: createVerificationCode(user.id, "email"),
          phone: input.phone ? createVerificationCode(user.id, "phone") : undefined,
        }
      : undefined;

    return { user: sanitizeUser(user), token, ...(devVerificationCodes ? { devVerificationCodes } : {}) };
  },

  async login(input: { email: string; password: string }, meta?: { userAgent?: string; ipAddress?: string }) {
    const user = await prisma.user.findUnique({ where: { email: input.email.trim().toLowerCase() } });
    if (!user) fail(401, "Invalid email or password. Please check your details and try again.");

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) fail(401, "Invalid email or password. Please check your details and try again.");

    const token = signSession(user.id);
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
    verifyVerificationCode(input.userId, "email", input.code);
    const updated = await prisma.user.update({
      where: { id: input.userId },
      data: { emailVerified: true },
    });
    return sanitizeUser(updated);
  },

  async verifyPhone(input: { userId: string; code: string }) {
    const user = await prisma.user.findUnique({ where: { id: input.userId } });
    if (!user) fail(404, "Account not found. Please sign up again.");
    if (!user.phone) fail(400, "No phone number is linked to this account.");
    if (user.phoneVerified) return sanitizeUser(user); // idempotent
    verifyVerificationCode(input.userId, "phone", input.code);
    const updated = await prisma.user.update({
      where: { id: input.userId },
      data: { phoneVerified: true },
    });
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
    return { success: true, ...(env.DEV_VERIFICATION_MODE && env.NODE_ENV !== "production" ? { devCode: createVerificationCode(userId, channel) } : {}) };
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
    const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { pinHash } });
    return { success: true };
  },

  async verifyPin(userId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) {
      fail(400, "PIN must be 6 digits");
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) {
      fail(409, "No PIN set for this account");
    }
    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      fail(401, "Incorrect PIN");
    }
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
    const valid = await bcrypt.compare(currentPin, user.pinHash);
    if (!valid) {
      fail(401, "Current PIN is incorrect");
    }
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
    if (!session || session.userId !== userId) {
      fail(404, "Session not found");
    }
    if (session.token === currentToken) {
      fail(400, "Cannot revoke your current session — log out instead");
    }
    await prisma.session.delete({ where: { id: sessionId } });
    return { success: true };
  },
};
