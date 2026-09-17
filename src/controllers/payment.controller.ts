import type { FastifyRequest, FastifyReply } from "fastify";
import { paymentService } from "../services/payment/payment.service.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { z } from "zod";

const requestSchema = z.object({
  asset: z.string().trim().min(1).max(20).optional(),
  symbol: z.string().trim().min(1).max(20).optional(),
  amount: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  expiresAt: z.string().datetime().optional(),
}).refine((value) => value.asset || value.symbol, "asset is required");

function handleError(err: unknown, reply: FastifyReply) {
  const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : "Something went wrong";
  return reply.code(statusCode).send(errorResponse(message));
}

export const paymentController = {
  async createRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await paymentService.createRequest(request.userId!, requestSchema.parse(request.body));
      return reply.code(201).send(successResponse(result));
      } catch (err) {
        return reply.code(err instanceof z.ZodError ? 400 : (err as any)?.statusCode ?? 500)
          .send(errorResponse(err instanceof Error ? err.message : "Something went wrong"));
    }
  },

  async getRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const result = await paymentService.getRequest(id);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async fulfillRequest(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const body = z.object({ transactionId: z.string().uuid() }).parse(request.body);
      return reply.send(successResponse(await paymentService.fulfillRequest(id, request.userId!, body.transactionId)));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
