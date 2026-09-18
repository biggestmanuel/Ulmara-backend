import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { authService } from "../services/auth/auth.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";

// Signup/login are the most-abused endpoints; keep the shared global limit
// from app.ts but nothing stricter here for now.
const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{10,15}$/, "Enter a valid phone number (10-15 digits)")
    .optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const verifySchema = z.object({
  userId: z.string().uuid("Invalid user reference"),
  code: z.string().regex(/^\d{6}$/, "Verification code must be 6 digits"),
});

const resendSchema = z.object({
  userId: z.string().uuid("Invalid user reference"),
  channel: z.enum(["email", "phone"]),
});

const pinSchema = z.object({
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
});

const changePinSchema = z.object({
  currentPin: z.string().regex(/^\d{6}$/, "Current PIN must be 6 digits"),
  newPin: z.string().regex(/^\d{6}$/, "New PIN must be 6 digits"),
});

const forgotPasswordSchema = z.object({
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
      const result = await authService.verifyEmail(body);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyPhone(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = verifySchema.parse(request.body);
      const result = await authService.verifyPhone(body);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async resendCode(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = resendSchema.parse(request.body);
      const result = await authService.resendVerificationCode(body.userId, body.channel);
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
      const { id } = request.params as { id: string };
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
