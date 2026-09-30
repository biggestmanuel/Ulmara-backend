import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { strictObject } from "../utils/requestSchemas.js";
import { authService } from "../services/auth/auth.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { idParamSchema } from "../utils/requestSchemas.js";

// Signup/login are the most-abused endpoints; keep the shared global limit
// from app.ts but nothing stricter here for now.
// `strictObject` (src/utils/requestSchemas.ts) rejects unknown keys: a typo such
// as `network` for `chain`, or a field from an older client, must be a 400
// rather than a silently dropped value. It is used instead of zod v4's
// `.strict()` because that method does not type-check on the inferred
// object type in this project.
const signupSchema = strictObject({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{10,15}$/, "Enter a valid phone number (10-15 digits)")
    .optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const loginSchema = strictObject({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

/**
 * Verification bodies carry ONLY the code.
 *
 * These routes are authenticated (`requireAuth` sets `request.userId` from the
 * session token), and the account being verified is therefore the caller's own.
 * The schema used to accept a body-supplied `userId` and the service used it
 * directly, so an authenticated caller could complete verification, or burn
 * another user's resend budget, for an arbitrary account id. The identity now
 * comes only from the verified session, which is also what makes the per-user
 * rate limit meaningful.
 */
const verifySchema = strictObject({
  code: z.string().regex(/^\d{6}$/, "Verification code must be 6 digits"),
});

const resendSchema = strictObject({
  channel: z.enum(["email", "phone"]),
});

const pinSchema = strictObject({
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
});

const changePinSchema = strictObject({
  currentPin: z.string().regex(/^\d{6}$/, "Current PIN must be 6 digits"),
  newPin: z.string().regex(/^\d{6}$/, "New PIN must be 6 digits"),
});

const forgotPasswordSchema = strictObject({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});

export const authController = {
  async signup(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = signupSchema.parse(request.body);
      const meta = { userAgent: request.headers["user-agent"], ipAddress: request.ip };
      const result = await authService.signup(body, meta);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async login(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = loginSchema.parse(request.body);
      const meta = { userAgent: request.headers["user-agent"], ipAddress: request.ip };
      const result = await authService.login(body, meta);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = verifySchema.parse(request.body);
      const result = await authService.verifyEmail({ ...body, userId: request.userId! });
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyPhone(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = verifySchema.parse(request.body);
      const result = await authService.verifyPhone({ ...body, userId: request.userId! });
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async resendCode(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = resendSchema.parse(request.body);
      const result = await authService.resendVerificationCode(request.userId!, body.channel);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async forgotPassword(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = forgotPasswordSchema.parse(request.body);
      const result = await authService.requestPasswordReset(body);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async setPin(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = pinSchema.parse(request.body);
      const result = await authService.setPin(request.userId!, body.pin);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyPin(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = pinSchema.parse(request.body);
      const result = await authService.verifyPin(request.userId!, body.pin);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async changePin(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = changePinSchema.parse(request.body);
      const result = await authService.changePin(request.userId!, body.currentPin, body.newPin);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async listSessions(request: FastifyRequest, reply: FastifyReply) {
    try {
      const authHeader = request.headers.authorization!;
      const currentToken = authHeader.slice(7);
      const result = await authService.listSessions(request.userId!, currentToken);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async revokeSession(request: FastifyRequest, reply: FastifyReply) {
    try {
      const authHeader = request.headers.authorization!;
      const currentToken = authHeader.slice(7);
      const { id } = idParamSchema.parse(request.params);
      const result = await authService.revokeSession(request.userId!, id, currentToken);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async deleteAccount(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await authService.deleteAccount(request.userId!);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
