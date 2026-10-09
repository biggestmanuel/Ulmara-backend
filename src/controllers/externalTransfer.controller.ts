import type { FastifyRequest, FastifyReply } from "fastify";
import {
  externalPrepareSchema,
  externalSubmitSchema,
  idParamSchema,
} from "../utils/requestSchemas.js";
import { externalTransferService } from "../services/transaction/externalTransfer.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";

export const externalTransferController = {
  async prepare(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = externalPrepareSchema.parse(request.body);
      const result = await externalTransferService.prepare({
        userId: request.userId!,
        chain: body.chain,
        asset: body.asset,
        amount: body.amount,
        to: body.to,
        pin: body.pin,
      });
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async submit(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = idParamSchema.parse(request.params);
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
        return reply.code(400).send({ success: false, message: "Invalid transfer intent id" });
      }
      const body = externalSubmitSchema.parse(request.body);
      const result = await externalTransferService.submit(request.userId!, id, body.signedTransaction, body.idempotencyKey);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
