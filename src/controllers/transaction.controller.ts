import type { FastifyRequest, FastifyReply } from "fastify";
import { transactionService } from "../services/transaction/transaction.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import {
  idParamSchema,
  paginationQuerySchema,
  signedTxSchema,
  transactionFeeSchema,
  transactionSendSchema,
} from "../utils/requestSchemas.js";

export const transactionController = {
  async estimateFee(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = transactionFeeSchema.parse(request.body);
      return reply.send(successResponse(await transactionService.estimateFee({ senderId: request.userId!, ...body })));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async send(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = transactionSendSchema.parse(request.body);
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
