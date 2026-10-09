import type { FastifyRequest, FastifyReply } from "fastify";
import { walletService } from "../services/wallet/wallet.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { accountIdParamSchema, chainParamSchema, registerWalletsSchema, tokenBalancesQuerySchema } from "../utils/requestSchemas.js";

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
      const { accountId } = accountIdParamSchema.parse(request.params);
      const result = await walletService.resolveAccountId(accountId);
      return reply.send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async registerWallets(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { addresses } = registerWalletsSchema.parse(request.body);
      const result = await walletService.registerWallets(request.userId!, addresses);
      return reply.code(200).send(successResponse(result));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  async listTokens(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { chain } = chainParamSchema.parse(request.params);
      return reply.send(successResponse(await walletService.listSupportedTokens(chain)));
    } catch (err) {
      return handleError(err, reply);
    }
  },

  /** B5/C5: token balances for one chain + one address. */
  async tokenBalances(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { chain, address } = tokenBalancesQuerySchema.parse(request.query);
      return reply.send(successResponse(await walletService.getTokenBalancesForChain(chain, address)));
    } catch (err) {
      return handleError(err, reply);
    }
  },
};
