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
    // An HttpError is the codebase's deliberate, user-facing channel: every one
    // is written as copy meant for a person ("Naira deposits are temporarily
    // unavailable. Please try again shortly.", "SMS verification is not
    // available yet. Verify your email instead."). Replacing those with a generic
    // string discarded nine hand-written messages across auth, ramp and external
    // transfers — the frontend saw "Something went wrong" for a 503 that had an
    // explanation sitting right there.
    //
    // Anything that is NOT an HttpError is an unexpected crash whose message may
    // contain internals (a SQL fragment, a file path, a provider URL), so that
    // case still gets the generic text.
    if (err instanceof HttpError) {
      return reply.code(statusCode).send(errorResponse(err.message));
    }
    return reply.code(statusCode).send(errorResponse("Something went wrong. Please try again."));
  }
  return reply.code(statusCode).send(errorResponse(message));
}
