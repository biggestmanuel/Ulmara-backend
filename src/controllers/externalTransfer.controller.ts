import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { externalTransferService } from "../services/transaction/externalTransfer.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import type { ChainName } from "../chains/index.js";

// Same chain set as /transaction/send; asset legality per chain is enforced
// in the service (native assets only for now).
const chainEnum = z.enum(["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"]);

const prepareSchema = z.object({
  chain: chainEnum,
  asset: z.string().trim().min(1).max(20),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Amount must be a positive decimal")
    .refine((value) => Number(value) > 0, "Amount must be greater than zero"),
  to: z.string().trim().min(1).max(120),
  // Authorization PIN, verified server-side with the same lockout rules as
  // internal transfers (5 wrong attempts -> 15-minute lockout).
  pin: z.string().regex(/^\d{6}$/, "PIN must be 6 digits"),
});

const submitSchema = z.object({
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
        chain: body.chain as ChainName,
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
      const { id } = request.params as { id: string };
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
