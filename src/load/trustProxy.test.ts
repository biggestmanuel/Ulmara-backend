import { describe, expect, it } from "vitest";
import { resolveTrustProxy } from "../server/app.js";

/**
 * `trustProxy` decides what `request.ip` returns, and `request.ip` is the key
 * every rate limiter in this app uses. Getting it wrong has two distinct
 * failure modes, both of which are security problems rather than cosmetic
 * ones:
 *
 *  - Unset behind a proxy: every user shares one budget per route, so one
 *    abusive client is a denial of service against `/login` for everyone.
 *  - `true` on a directly-reachable app: a client forges `X-Forwarded-For` to
 *    get a fresh budget, or to burn someone else's.
 *
 * These cases pin the resolution order and the safe defaults.
 */
describe("resolveTrustProxy", () => {
  it("defaults to false when nothing is configured", () => {
    // Correct for a directly-reachable app: the socket peer is the client.
    expect(resolveTrustProxy("", undefined)).toBe(false);
    expect(resolveTrustProxy("   ", undefined)).toBe(false);
    // A partially-mocked env must not make this helper throw.
    expect(resolveTrustProxy(undefined, undefined)).toBe(false);
  });

  it("treats '*' as trust-everything, for a chain that overwrites the header", () => {
    expect(resolveTrustProxy("*", undefined)).toBe(true);
    expect(resolveTrustProxy("10.0.0.1,*", undefined)).toBe(true);
  });

  it("returns an address list, which fails safe for unknown peers", () => {
    expect(resolveTrustProxy("10.0.0.0/8,172.17.0.1", undefined)).toEqual(["10.0.0.0/8", "172.17.0.1"]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(resolveTrustProxy(" 10.0.0.1 , ,10.0.0.2 ", undefined)).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("expresses a hop count as a predicate Fastify's type accepts", () => {
    // Fastify's `trustProxy` type has no numeric form, so N hops is expressed
    // as the equivalent predicate. Hop 1 is the socket peer.
    const trust1 = resolveTrustProxy("", 1) as (a: string, hop: number) => boolean;
    expect(typeof trust1).toBe("function");
    expect(trust1("10.0.0.9", 1)).toBe(true);
    expect(trust1("203.0.113.7", 2)).toBe(false);

    const trust2 = resolveTrustProxy("", 2) as (a: string, hop: number) => boolean;
    expect(trust2("203.0.113.7", 2)).toBe(true);
  });

  it("treats a hop count of 0 as trusting nothing", () => {
    expect(resolveTrustProxy("", 0)).toBe(false);
  });

  it("prefers an explicit address list over a hop count", () => {
    // The list is the safer of the two, so it wins when both are present.
    expect(resolveTrustProxy("10.0.0.1", 3)).toEqual(["10.0.0.1"]);
  });
});
