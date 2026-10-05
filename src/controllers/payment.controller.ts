import type { FastifyRequest, FastifyReply } from "fastify";
import { paymentService } from "../services/payment/payment.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { idParamSchema, paymentFulfillSchema, paymentRequestSchema } from "../utils/requestSchemas.js";

export const paymentController = {
  async createRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await paymentService.createRequest(request.userId!, paymentRequestSchema.parse(request.body));
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = idParamSchema.parse(request.params);
      const result = await paymentService.getRequest(id);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async fulfillRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = idParamSchema.parse(request.params);
      const { transactionId } = paymentFulfillSchema.parse(request.body);
      return reply.send(successResponse(await paymentService.fulfillRequest(id, request.userId!, transactionId)));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
