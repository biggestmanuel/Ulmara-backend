import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import { HttpError, handleError } from "./apiResponse.js";

// ---------------------------------------------------------------------------
// Which error message reaches the client.
//
// The rule being pinned: an `HttpError` is the codebase's deliberate,
// user-facing channel and its message survives ANY status code. Anything else
// that lands on a 5xx is an unexpected crash whose message may contain internals,
// so it is replaced with generic text.
//
// The bug this guards: `handleError` replaced EVERY 5xx message with "Something
// went wrong", which silently discarded nine hand-written, carefully-worded
// messages. `fail(503, "Naira deposits are temporarily unavailable. Please try
// again shortly.")` reached the client as "Something went wrong. Please try
// again." — the explanation existed in the source and was thrown away. The
// frontend reported that 503 as "unhelpful" without knowing why.
//
// The security half matters just as much: loosening this must not start leaking
// driver errors, SQL fragments or file paths.
// ---------------------------------------------------------------------------

/** Minimal FastifyReply double: records what was sent. */
function reply() {
  const state = { status: 0, body: undefined as unknown };
  const r = {
    code(v: number) {
      state.status = v;
      return r;
    },
    send(v: unknown) {
      state.body = v;
      return r;
    },
  };
  return { r: r as unknown as FastifyReply, state };
}

describe("handleError — HttpError keeps its message at every status", () => {
  it("surfaces a 503 instead of the generic string", () => {
    // The exact case the frontend hit.
    const { r, state } = reply();
    handleError(new HttpError(503, "Naira deposits are temporarily unavailable. Please try again shortly."), r);
    expect(state.status).toBe(503);
    expect(state.body).toEqual({
      success: false,
      message: "Naira deposits are temporarily unavailable. Please try again shortly.",
    });
  });

  it("surfaces a 501 that tells the user what to do instead", () => {
    const { r, state } = reply();
    handleError(new HttpError(501, "SMS verification is not available yet. Verify your email instead."), r);
    expect(state.status).toBe(501);
    expect((state.body as { message: string }).message).toMatch(/Verify your email instead/);
  });

  it("surfaces a 502 with an actionable retry hint", () => {
    const { r, state } = reply();
    handleError(new HttpError(502, "Could not estimate the network fee right now. Try again shortly."), r);
    expect(state.status).toBe(502);
    expect((state.body as { message: string }).message).toMatch(/Try again shortly/);
  });

  it("still surfaces 4xx messages unchanged", () => {
    const { r, state } = reply();
    handleError(new HttpError(404, "Contact not found"), r);
    expect(state.status).toBe(404);
    expect((state.body as { message: string }).message).toBe("Contact not found");
  });
});

describe("handleError — an unexpected crash still says nothing", () => {
  it("replaces a plain Error on a 500, so internals never leak", () => {
    const { r, state } = reply();
    handleError(new Error('relation "public.User" does not exist'), r);
    expect(state.status).toBe(500);
    expect((state.body as { message: string }).message).toBe("Something went wrong. Please try again.");
    // The load-bearing assertion: the driver's own text must NOT appear.
    expect(JSON.stringify(state.body)).not.toContain("public.User");
  });

  it("does not leak a stack-bearing error's message", () => {
    const { r, state } = reply();
    const err = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    (err as Error & { statusCode?: number }).statusCode = 500;
    handleError(err, r);
    expect(JSON.stringify(state.body)).not.toContain("5432");
  });

  it("handles a thrown non-Error without throwing itself", () => {
    const { r, state } = reply();
    expect(() => handleError("a bare string", r)).not.toThrow();
    expect(state.status).toBe(500);
    expect((state.body as { message: string }).message).toBe("Something went wrong. Please try again.");
  });

  it("does not treat a string with statusCode as a safe message", () => {
    // The statusCode is read off a plain object too, but only HttpError earns
    // the right to have its text shown on a 5xx.
    const { r, state } = reply();
    handleError(Object.assign(new Error("postgres://user:pw@host/db"), { statusCode: 500 }), r);
    expect(JSON.stringify(state.body)).not.toContain("postgres://");
  });
});

describe("handleError — validation still reports the field", () => {
  it("names the offending field on a ZodError", async () => {
    const { z } = await import("zod");
    const { r, state } = reply();
    const schema = z.strictObject({ pin: z.string().regex(/^\d{6}$/) });
    const parsed = schema.safeParse({ pin: "abc" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      handleError(parsed.error, r);
      expect(state.status).toBe(400);
      expect((state.body as { message: string }).message).toMatch(/pin/);
    }
  });
});

describe("every deliberate 5xx in the codebase is now reachable", () => {
  it("the ramp messages the frontend could not see", async () => {
    // Spelled out here rather than importing the service, because the point is
    // the exact strings that were being swallowed.
    const cases: [number, string][] = [
      [503, "Naira deposits are temporarily unavailable. Please try again shortly."],
      [503, "Naira withdrawals are temporarily unavailable. Please try again shortly."],
      [501, "SMS verification is not available yet. Verify your email instead."],
    ];
    for (const [status, message] of cases) {
      const { r, state } = reply();
      handleError(new HttpError(status, message), r);
      expect((state.body as { message: string }).message, message).toBe(message);
    }
  });
});