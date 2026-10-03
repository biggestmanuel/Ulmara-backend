import type { FastifyRequest, FastifyReply } from "fastify";
import { accountService } from "../services/account/account.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { accountIdParamSchema, settingsSchema } from "../utils/requestSchemas.js";

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
      const { accountId } = accountIdParamSchema.parse(request.params);
      const result = await accountService.getByAccountId(accountId);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async resolveForTransfer(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { accountId } = accountIdParamSchema.parse(request.params);
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
