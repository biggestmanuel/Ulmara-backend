import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { strictObject } from "../utils/requestSchemas.js";
import { contactService } from "../services/contact.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";
import { CHAIN_NAMES } from "../chains/index.js";

const schema = strictObject({
  name: z.string().trim().min(1).max(100),
  accountId: z.string().regex(/^\d{10}$/).optional(),
  address: z.string().trim().min(1).max(120).optional(),
  chain: z.enum(CHAIN_NAMES).optional(),
});

/**
 * `Contact.id` is a Prisma uuid. Validating it here means a malformed id is a
 * clean 400 instead of a driver-level error, and it keeps the delete query's
 * `where` provably a well-formed identifier.
 */
const paramsSchema = strictObject({
  id: z.string().uuid(),
});

export const contactController = {
  async list(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.send(successResponse(await contactService.list(req.userId!))); } catch (e) { return handleError(e, reply); }
  },
  async create(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.code(201).send(successResponse(await contactService.create(req.userId!, schema.parse(req.body)))); } catch (e) { return handleError(e, reply); }
  },
  async remove(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.send(successResponse(await contactService.remove(req.userId!, paramsSchema.parse(req.params).id))); } catch (e) { return handleError(e, reply); }
  },
};
