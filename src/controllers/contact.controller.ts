import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { contactService } from "../services/contact.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  accountId: z.string().regex(/^\d{10}$/).optional(),
  address: z.string().trim().min(1).max(120).optional(),
  chain: z.enum(["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"]).optional(),
});

export const contactController = {
  async list(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.send(successResponse(await contactService.list(req.userId!))); } catch (e) { return handleError(e, reply); }
  },
  async create(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.code(201).send(successResponse(await contactService.create(req.userId!, schema.parse(req.body)))); } catch (e) { return handleError(e, reply); }
  },
  async remove(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.send(successResponse(await contactService.remove(req.userId!, (req.params as any).id))); } catch (e) { return handleError(e, reply); }
  },
};
