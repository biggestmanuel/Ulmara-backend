import type { FastifyRequest, FastifyReply } from "fastify";
import { authService } from "../services/auth/auth.service.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";

function handleError(err: unknown, reply: FastifyReply) {
  const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : "Something went wrong";
  return reply.code(statusCode).send(errorResponse(message));
}

export const authController = {
  async signup(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { email: string; phone?: string; password: string };
      const meta = { userAgent: request.headers["user-agent"], ipAddress: request.ip };
      const result = await authService.signup(body, meta);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async login(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { email: string; password: string };
      const meta = { userAgent: request.headers["user-agent"], ipAddress: request.ip };
      const result = await authService.login(body, meta);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyEmail(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { userId: string; code: string };
      const result = await authService.verifyEmail(body);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyPhone(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { userId: string; code: string };
      const result = await authService.verifyPhone(body);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async forgotPassword(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { email: string };
      const result = await authService.requestPasswordReset(body);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async setPin(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { pin: string };
      const result = await authService.setPin(request.userId!, body.pin);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async verifyPin(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { pin: string };
      const result = await authService.verifyPin(request.userId!, body.pin);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async changePin(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { currentPin: string; newPin: string };
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
};
