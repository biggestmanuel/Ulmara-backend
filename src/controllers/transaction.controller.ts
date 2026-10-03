import type { FastifyRequest, FastifyReply } from "fastify";
import { transactionService } from "../services/transaction/transaction.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { CHAIN_NAMES } from "../chains/index.js";
import { moneyString } from "../utils/money.js";
import { idParamSchema, paginationQuerySchema, signedTxSchema } from "../utils/requestSchemas.js";
import { z } from "zod";
import { strictObject } from "../utils/requestSchemas.js";

const sendSchema = strictObject({
  recipientAccountId: z.string().regex(/^\d{10}$/, "Recipient Account ID must be 10 digits").optional(),
  recipientAddress: z.string().trim().min(1).max(120).optional(),
  asset: z.string().trim().min(1).max(20),
  amount: moneyString(),
  network: z.enum(CHAIN_NAMES),
  // Authorization PIN, verified server-side against the stored hash before
  // any transaction is created. Format-only here; the lockout service owns
  // the actual comparison so failures are counted centrally.
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
  // Client-generated UUID, one per transfer attempt: repeats (network
  // timeout-and-retry, double-tap) replay the original transaction instead of
  // creating a second one. Required — without it the endpoint cannot
  // distinguish a retry from a new transfer.
  idempotencyKey: z.string().uuid("idempotencyKey must be a UUID"),
}).refine((v) => Boolean(v.recipientAccountId) !== Boolean(v.recipientAddress), {
  message: "Provide exactly one of recipientAccountId or recipientAddress",
});

export const transactionController = {
  async estimateFee(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = strictObject({
        recipientAddress: z.string().trim().min(1).max(120),
        asset: z.string().trim().min(1).max(20),
        amount: z.string().regex(/^\d+(\.\d+)?$/),
        network: z.enum(CHAIN_NAMES),
      }).parse(request.body);
      return reply.send(successResponse(await transactionService.estimateFee({ senderId: request.userId!, ...body })));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async send(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = sendSchema.parse(request.body);
      const result = await transactionService.send({ senderId: request.userId!, ...body });
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async list(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { page, limit } = paginationQuerySchema.parse(request.query);
      const result = await transactionService.list(request.userId!, page, limit);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = idParamSchema.parse(request.params);
      const result = await transactionService.getById(request.userId!, id);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = idParamSchema.parse(request.params);
      const result = await transactionService.getStatus(request.userId!, id);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async broadcast(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = idParamSchema.parse(request.params);
      const { signedTx } = signedTxSchema.parse(request.body);
      // A repeated broadcast with the same signedTx replays the row rather
      // than enqueueing a second broadcast job.
      const result = await transactionService.broadcast(request.userId!, id, signedTx);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
