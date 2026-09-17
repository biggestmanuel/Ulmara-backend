import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyAddressExists } from "../blockchain/triverify.js";
import { errorResponse, successResponse } from "../utils/apiResponse.js";
import type { ChainName } from "../chains/index.js";

const validationSchema = z.object({
  address: z.string().trim().min(1).max(120),
  chain: z.enum(["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"]),
});

export const validationController = {
  async address(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { address, chain } = validationSchema.parse(request.body);
      const result = await verifyAddressExists(address, chain as ChainName);
      return reply.send(successResponse({
        address,
        chain,
        formatValid: result.formatValid,
        exists: result.existsOnChain,
      }));
    } catch (error) {
      const statusCode = error instanceof z.ZodError
        ? 400
        : (error as { statusCode?: number }).statusCode ?? 400;
      const message = error instanceof Error ? error.message : "Address validation failed";
      return reply.code(statusCode).send(errorResponse(message));
    }
  },
};
