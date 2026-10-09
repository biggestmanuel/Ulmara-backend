import type { FastifyReply, FastifyRequest } from "fastify";
import {
  contactCreateSchema,
  contactParamsSchema,
  contactUpdateSchema,
} from "../utils/requestSchemas.js";
import { contactService } from "../services/contact.service.js";
import { successResponse, handleError } from "../utils/apiResponse.js";

export const contactController = {
  async list(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.send(successResponse(await contactService.list(req.userId!))); } catch (e) { return handleError(e, reply); }
  },
  async create(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.code(201).send(successResponse(await contactService.create(req.userId!, contactCreateSchema.parse(req.body)))); } catch (e) { return handleError(e, reply); }
  },
  async update(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = contactParamsSchema.parse(req.params);
      return reply.send(successResponse(await contactService.update(req.userId!, id, contactUpdateSchema.parse(req.body))));
    } catch (e) { return handleError(e, reply); }
  },
  async remove(req: FastifyRequest, reply: FastifyReply) {
    try { return reply.send(successResponse(await contactService.remove(req.userId!, contactParamsSchema.parse(req.params).id))); } catch (e) { return handleError(e, reply); }
  },
};
