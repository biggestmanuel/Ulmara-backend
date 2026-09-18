import type { FastifyReply } from "fastify";
import { z } from "zod";

// Typed error services can throw; controllers map it straight onto the
// response instead of leaking a raw 500 with a stack-shaped message.
export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function successResponse<T>(data: T) {
  return { success: true, data };
}

export function errorResponse(message: string) {
  return { success: false, message };
}

// Shared controller error handler. Services signal expected failures by
// throwing an Error with a `statusCode` property (or HttpError); anything
// else is an unexpected crash and stays a 500 with a generic message.
// Zod validation failures are surfaced as readable 400s.
export function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const detail = first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input";
    return reply.code(400).send(errorResponse(detail));
  }

  const statusCode =
    err instanceof HttpError
      ? err.statusCode
      : ((err as { statusCode?: number } | null)?.statusCode ?? 500);
  const message = err instanceof Error ? err.message : "Something went wrong";

  if (statusCode >= 500) {
    // Log unexpected failures server-side; never echo internals to the client.
    return reply.code(statusCode).send(errorResponse("Something went wrong. Please try again."));
  }
  return reply.code(statusCode).send(errorResponse(message));
}
