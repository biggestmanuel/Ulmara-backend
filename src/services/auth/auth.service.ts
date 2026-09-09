// bcryptjs does not currently ship TypeScript declarations.
// @ts-expect-error — the package exposes the required runtime API.
import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import crypto from "node:crypto";
import { prisma } from "../../config/database.js";
import { env } from "../../config/env.js";

const SALT_ROUNDS = 12;

function signSession(userId: string) {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions["expiresIn"],
  });
}

function sessionExpiry(): Date {
  const days = parseInt(env.JWT_EXPIRES_IN) || 7;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function sanitizeUser<T extends { passwordHash: string; pinHash: string | null }>(user: T) {
  const { passwordHash, pinHash, ...safe } = user;
  return safe;
}

export const authService = {
  async signup(input: { email: string; phone?: string; password: string }, meta?: { userAgent?: string; ipAddress?: string }) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw Object.assign(new Error("Email already in use"), { statusCode: 409 });

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: { email: input.email, phone: input.phone, passwordHash },
    });

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

    // TODO: real email/SMS delivery — no provider wired yet
    return { user: sanitizeUser(user), token };
  },

  async login(input: { email: string; password: string }, meta?: { userAgent?: string; ipAddress?: string }) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) throw Object.assign(new Error("Invalid email or password"), { statusCode: 401 });

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) throw Object.assign(new Error("Invalid email or password"), { statusCode: 401 });

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
    // TODO: check against a real stored OTP once email delivery exists — any 6-digit code passes for now
    if (!/^\d{6}$/.test(input.code)) throw Object.assign(new Error("Invalid code"), { statusCode: 400 });
    const user = await prisma.user.update({ where: { id: input.userId }, data: { emailVerified: true } });
    return sanitizeUser(user);
  },

  async verifyPhone(input: { userId: string; code: string }) {
    if (!/^\d{6}$/.test(input.code)) throw Object.assign(new Error("Invalid code"), { statusCode: 400 });
    const user = await prisma.user.update({ where: { id: input.userId }, data: { phoneVerified: true } });
    return sanitizeUser(user);
  },

  async requestPasswordReset(input: { email: string }) {
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) return { success: true }; // don't leak which emails exist
    const resetToken = crypto.randomBytes(32).toString("hex"); // TODO: persist + email this
    return { success: true, resetToken };
  },

  async resetPassword() {
    // No reset-token table exists yet — needs a schema addition before this can work for real
    throw Object.assign(new Error("Password reset not yet available"), { statusCode: 501 });
  },

  async setPin(userId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) {
      throw Object.assign(new Error("PIN must be 6 digits"), { statusCode: 400 });
    }
    const pinHash = await bcrypt.hash(pin, SALT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { pinHash } });
    return { success: true };
  },

  async verifyPin(userId: string, pin: string) {
    if (!/^\d{6}$/.test(pin)) {
      throw Object.assign(new Error("PIN must be 6 digits"), { statusCode: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) {
      throw Object.assign(new Error("No PIN set for this account"), { statusCode: 409 });
    }
    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      throw Object.assign(new Error("Incorrect PIN"), { statusCode: 401 });
    }
    return { valid: true };
  },

  async changePin(userId: string, currentPin: string, newPin: string) {
    if (!/^\d{6}$/.test(newPin)) {
      throw Object.assign(new Error("PIN must be 6 digits"), { statusCode: 400 });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) {
      throw Object.assign(new Error("No PIN set for this account"), { statusCode: 409 });
    }
    const valid = await bcrypt.compare(currentPin, user.pinHash);
    if (!valid) {
      throw Object.assign(new Error("Current PIN is incorrect"), { statusCode: 401 });
    }
    const pinHash = await bcrypt.hash(newPin, SALT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { pinHash } });
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
      throw Object.assign(new Error("Session not found"), { statusCode: 404 });
    }
    if (session.token === currentToken) {
      throw Object.assign(new Error("Cannot revoke your current session — log out instead"), { statusCode: 400 });
    }
    await prisma.session.delete({ where: { id: sessionId } });
    return { success: true };
  },
};
