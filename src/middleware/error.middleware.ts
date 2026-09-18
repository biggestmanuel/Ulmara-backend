import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";

// Fallback for errors that escape controller try/catch (framework errors,
// malformed JSON, etc.). Same envelope shape as utils/apiResponse.errorResponse
// so the frontend only ever deals with one error format.
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    logger.error({ err: error, url: request.url }, "Request error");
  }

  reply.code(statusCode).send({
    success: false,
    message:
      statusCode >= 500
        ? "Something went wrong. Please try again."
        : error.message || "Request failed",
  });
}
