import type { FastifyRequest, FastifyReply } from "fastify";
import { rampService } from "../services/ramp/ramp.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";

export const rampController = {
  async deposit(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await rampService.deposit(request.userId!, request.body as any);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async withdraw(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await rampService.withdraw(request.userId!, request.body as any);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { reference } = request.params as { reference: string };
      const result = await rampService.getStatus(request.userId!, reference);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
