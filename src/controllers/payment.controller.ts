import type { FastifyRequest, FastifyReply } from "fastify";
import { paymentService } from "../services/payment/payment.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { z } from "zod";
import { strictObject } from "../utils/requestSchemas.js";
import { moneyString } from "../utils/money.js";
import { idParamSchema } from "../utils/requestSchemas.js";

const requestSchema = strictObject({
  asset: z.string().trim().min(1).max(20).optional(),
  symbol: z.string().trim().min(1).max(20).optional(),
  amount: moneyString().optional(),
  expiresAt: z.string().datetime().optional(),
// Both fields are `.min(1).optional()`, so by the time this refine runs each is
// either absent or a non-empty string: an explicit presence check is exactly
// equivalent to the truthiness check and states the intent more precisely.
}).refine((value) => value.asset !== undefined || value.symbol !== undefined, "asset is required");

/** Body of POST /request/:id/fulfill: the transaction that settles the request. */
const fulfillSchema = z
  .object({
    transactionId: z.string().uuid("transactionId must be a valid UUID"),
  })


export const paymentController = {
  async createRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await paymentService.createRequest(request.userId!, requestSchema.parse(request.body));
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
      const { transactionId } = fulfillSchema.parse(request.body);
      return reply.send(successResponse(await paymentService.fulfillRequest(id, request.userId!, transactionId)));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
