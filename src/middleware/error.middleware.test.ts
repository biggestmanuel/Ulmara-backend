import { describe, expect, it } from "vitest";
import { HttpError, handleError } from "../utils/apiResponse.js";
import { errorHandler } from "../middleware/error.middleware.js";
import type { FastifyReply } from "fastify";

// ---------------------------------------------------------------------------
// The other half of the 5xx rule, which the apiResponse suite cannot cover: the
// messages that MUST stay hidden.
//
// `handleError` now surfaces a 5xx message when the error is an HttpError, which
// is safe only because HttpError means "deliberately written for the user". The
// codebase's other 500s are ad-hoc `Object.assign(new Error(...), { statusCode:
// 500 })` throws carrying INTERNAL configuration facts, and those must still be
// replaced with the generic string:
//
//   "USDC on BSC is configured for chain id 56, but this deployment runs 97"
//
// That tells an attacker the deployment's chain id and, more usefully, that the
// operator has a misconfigured token registry. It is a support diagnostic, not a
// user-facing message, so it belongs in the log and nowhere else.
//
// This file pins that split. If someone "simplifies" the ad-hoc throws into
// HttpError, these tests are what notices.
// ---------------------------------------------------------------------------

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

/** The real internal-config throw from evm.adapter.ts / tokens/registry.ts. */
function internalChainIdError(): Error {
  return Object.assign(
    new Error(
      "USDC on BSC is configured for chain id 56, but this deployment runs chain id 97",
    ),
    { statusCode: 500 },
  );
}

describe("handleError — internal configuration errors stay hidden", () => {
  it("does not leak a token-registry chain-id mismatch", () => {
    const { r, state } = reply();
    handleError(internalChainIdError(), r);
    expect(state.status).toBe(500);
    expect((state.body as { message: string }).message).toBe(
      "Something went wrong. Please try again.",
    );
    // Every fragment of the diagnostic must be absent from the response.
    const body = JSON.stringify(state.body);
    expect(body).not.toContain("chain id");
    expect(body).not.toContain("56");
    expect(body).not.toContain("97");
  });

  it("does not leak a Prisma driver error", () => {
    const { r, state } = reply();
    handleError(
      Object.assign(new Error('relation "public.User" does not exist'), { statusCode: 500 }),
      r,
    );
    expect(JSON.stringify(state.body)).not.toContain("public");
  });
});

describe("errorHandler — the Fastify-level fallback follows the same rule", () => {
  const request = {
    method: "POST",
    url: "/api/ramp/deposit",
    routeOptions: { url: "/api/ramp/deposit" },
  } as unknown as Parameters<typeof errorHandler>[1];

  it("surfaces a deliberate HttpError that escaped a handler", () => {
    // errorHandler is the fallback for anything that misses a controller's
    // try/catch. It must apply the same rule, or a service that throws outside
    // its own handler would be the one place the message is swallowed again.
    const { r, state } = reply();
    errorHandler(
      new HttpError(503, "Naira deposits are temporarily unavailable. Please try again shortly.") as never,
      request,
      r,
    );
    expect(state.status).toBe(503);
    expect((state.body as { message: string }).message).toMatch(/Naira deposits/);
  });

  it("still hides an internal error that escaped a handler", () => {
    const { r, state } = reply();
    errorHandler(internalChainIdError() as never, request, r);
    expect((state.body as { message: string }).message).toBe(
      "Something went wrong. Please try again.",
    );
    expect(JSON.stringify(state.body)).not.toContain("chain id");
  });

  it("passes a 4xx message through unchanged", () => {
    const { r, state } = reply();
    errorHandler(
      Object.assign(new Error("Malformed JSON"), { statusCode: 400 }) as never,
      request,
      r,
    );
    expect(state.status).toBe(400);
    expect((state.body as { message: string }).message).toBe("Malformed JSON");
  });
});

describe("the two conventions must not drift apart again", () => {
  it("every service fail() helper throws HttpError, not a bare Error", async () => {
    // The original defect: ramp and externalTransfer each had a local
    // `function fail() { throw Object.assign(new Error(m), { statusCode }) }`,
    // which silently opted their 5xx messages out of being user-visible. A
    // source-level guard is the only way to stop a fourth copy appearing.
    const { readFile } = await import("node:fs/promises");
    const files = [
      "src/services/auth/auth.service.ts",
      "src/services/ramp/ramp.service.ts",
      "src/services/transaction/externalTransfer.service.ts",
    ];
    for (const f of files) {
      const src = await readFile(new URL(`../../${f}`, import.meta.url), "utf8");
      expect(src, `${f} must not reintroduce a bare-Error fail()`).not.toMatch(
        /function fail\([^)]*\)[^{]*\{\s*throw Object\.assign/,
      );
    }
  });
});