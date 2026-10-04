import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../config/logger.js";
import { captureError, isSentryEnabled } from "../config/sentry.js";
import { HttpError } from "../utils/apiResponse.js";

/**
 * Fallback for errors that escape controller try/catch (framework errors,
 * malformed JSON, etc.). Same envelope shape as utils/apiResponse.errorResponse
 * so the frontend only ever deals with one error format.
 *
 * pino keeps the local log; Sentry additionally gets the error and a
 * deliberately narrow slice of request context. Never the body, never headers,
 * never a token.
 */
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const statusCode = error.statusCode ?? 500;

  if (statusCode >= 500) {
    // Safe context only: method, route, status, and the error itself. The
    // request body and headers are excluded because they carry PINs, JWTs and
    // signed transaction payloads.
    logger.error(
      {
        err: error,
        method: request.method,
        url: request.url,
        route: request.routeOptions?.url ?? null,
        statusCode,
      },
      "Request error",
    );
    captureError(error, {
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      statusCode,
      sentry: isSentryEnabled(),
    });
  }

  reply.code(statusCode).send({
    success: false,
    message:
      statusCode >= 500
        ? // Same rule as utils/apiResponse.handleError: an HttpError is a
          // deliberately-worded, user-facing message and must survive a 5xx; an
          // arbitrary thrown Error may carry internals and must not.
          error instanceof HttpError
          ? error.message
          : "Something went wrong. Please try again."
        : error.message || "Request failed",
  });
}
