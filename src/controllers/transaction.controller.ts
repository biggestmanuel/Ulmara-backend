import type { FastifyRequest, FastifyReply } from "fastify";
import { transactionService } from "../services/transaction/transaction.service.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import type { ChainName } from "../chains/index.js";
import { z } from "zod";

const sendSchema = z.object({
  recipientAccountId: z.string().regex(/^\d{10}$/, "Recipient Account ID must be 10 digits"),
  asset: z.string().trim().min(1).max(20),
  amount: z.string().regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal").refine((value) => Number(value) > 0, "Amount must be greater than zero"),
  network: z.enum(["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON"]),
});

function handleError(err: unknown, reply: FastifyReply) {
  const statusCode = err instanceof z.ZodError ? 400 : (err as { statusCode?: number })?.statusCode ?? 500;
  const message = err instanceof Error ? err.message : "Something went wrong";
  return reply.code(statusCode).send(errorResponse(message));
}

export const transactionController = {
  async send(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = sendSchema.parse(request.body) as {
        recipientAccountId: string;
        asset: string;
        amount: string;
        network: ChainName;
      };
      const result = await transactionService.send({ senderId: request.userId!, ...body });
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async list(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { page, limit } = request.query as { page?: string; limit?: string };
      const parsedPage = page ? Number(page) : 1;
      const parsedLimit = limit ? Number(limit) : 20;
      if (!Number.isInteger(parsedPage) || parsedPage < 1 || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return reply.code(400).send(errorResponse("Invalid page or limit"));
      }
      const result = await transactionService.list(
        request.userId!,
        parsedPage,
        parsedLimit
      );
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const result = await transactionService.getById(request.userId!, id);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const result = await transactionService.getStatus(request.userId!, id);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async broadcast(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const { signedTx } = request.body as { signedTx?: string };
      if (typeof signedTx !== "string" || signedTx.trim().length < 16 || signedTx.length > 1_000_000) {
        return reply.code(400).send(errorResponse("A serialized signed transaction is required"));
      }
      const result = await transactionService.broadcast(request.userId!, id, signedTx);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
