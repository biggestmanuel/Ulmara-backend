import type { FastifyRequest, FastifyReply } from "fastify";
import { walletService } from "../services/wallet/wallet.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import type { ChainName } from "../chains/index.js";

export const walletController = {
  async getBalances(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await walletService.getBalances(request.userId!);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async getAddresses(request: FastifyRequest, reply: FastifyReply) {
    try {
      const result = await walletService.getAddresses(request.userId!);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async resolveAccountId(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { accountId } = request.params as { accountId: string };
      const result = await walletService.resolveAccountId(accountId);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async registerWallets(request: FastifyRequest, reply: FastifyReply) {
    try {
      const body = request.body as { addresses: { chain: ChainName; address: string }[] };
      const result = await walletService.registerWallets(request.userId!, body.addresses);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
