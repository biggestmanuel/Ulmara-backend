import type { FastifyRequest, FastifyReply } from "fastify";
import { accountService } from "../services/account/account.service.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { z } from "zod";

const settingsSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  photoUrl: z.string().url().max(500).optional(),
  defaultCurrency: z.string().trim().length(3).toUpperCase().optional(),
  defaultLanguage: z.string().trim().min(2).max(10).optional(),
  defaultNetwork: z.enum(["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"]).optional(),
}).strict();

function handleError(err: unknown, reply: FastifyReply) {
  const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : "Something went wrong";
  return reply.code(statusCode).send(errorResponse(message));
}

export const accountController = {
  async me(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await accountService.me(request.userId!);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async createAccountId(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await accountService.createAccountId(request.userId!);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getByAccountId(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { accountId } = request.params as { accountId: string };
      const result = await accountService.getByAccountId(accountId);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async resolveForTransfer(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { accountId } = request.params as { accountId: string };
      const result = await accountService.resolveForTransfer(request.userId!, accountId);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async updateSettings(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await accountService.updateSettings(request.userId!, settingsSchema.parse(request.body));
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
