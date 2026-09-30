import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { strictObject } from "../utils/requestSchemas.js";
import { externalTransferService } from "../services/transaction/externalTransfer.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { CHAIN_NAMES } from "../chains/index.js";
import { moneyString } from "../utils/money.js";
import { idParamSchema } from "../utils/requestSchemas.js";

// Same chain set as /transaction/send; asset legality per chain is enforced
// in the service (native assets only for now). Values are the UPPERCASE wire
// identifiers from CHAIN_NAMES — the frontend (lib/api/externalTransfers.ts)
// sends exactly these.
const chainEnum = z.enum(CHAIN_NAMES);

const prepareSchema = strictObject({
  chain: chainEnum,
  asset: z.string().trim().min(1).max(20),
  amount: moneyString(),
  to: z.string().trim().min(1).max(120),
  // Authorization PIN, verified server-side with the same lockout rules as
  // internal transfers (5 wrong attempts -> 15-minute lockout).
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
});

const submitSchema = strictObject({
  signedTransaction: z.string().trim().min(16).max(1_000_000),
  // Client-generated UUID, one per submit attempt: a retry after a lost
  // response replays the original transaction instead of creating a second
  // ledger row and broadcasting the same signature twice.
  idempotencyKey: z.string().uuid("idempotencyKey must be a UUID"),
});

export const externalTransferController = {
  async prepare(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = prepareSchema.parse(request.body);
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
      const body = submitSchema.parse(request.body);
      const result = await externalTransferService.submit(request.userId!, id, body.signedTransaction, body.idempotencyKey);
      return reply.code(201).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
