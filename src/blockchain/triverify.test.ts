import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// verifyAddressExists — the gate in front of every Send.
//
// `verifyAddressOnChain` is mocked, so these tests are about THIS function's
// contract, not about TriVerify or any RPC. What that contract has to get right:
//
//   1. A malformed address never reaches the network. The adapter's format check
//      is the first thing that runs, and it short-circuits.
//   2. An address the chain cannot confirm THROWS a 400. It does not return
//      existsOnChain: false. That difference matters: a returned object reads as
//      "a definitive answer", while a throw blocks the send. This function is
//      the only thing standing between an unverified address and a transfer.
//   3. A verified address reports the real fields, not defaults.
//
// The failure mode this exists to prevent: someone "simplifying" the throw into
// a returned `existsOnChain: false`, which callers could then treat as a normal
// negative answer rather than a blocked send.
// ---------------------------------------------------------------------------

const { verifyAddressOnChain, getChainAdapter, chainValues } = vi.hoisted(() => ({
  verifyAddressOnChain: vi.fn(),
  getChainAdapter: vi.fn(),
  chainValues: {
    ETH: { isValidAddress: vi.fn() },
    SOL: { isValidAddress: vi.fn() },
  },
}));

vi.mock("./verify.js", () => ({ verifyAddressOnChain }));
vi.mock("../chains/index.js", () => ({
  getChainAdapter: (chain: string) => {
    getChainAdapter(chain);
    const found = chainValues[chain as keyof typeof chainValues];
    if (!found) throw new Error(`no test adapter for ${chain}`);
    return Promise.resolve(found);
  },
}));

const { verifyAddressExists } = await import("./triverify.js");

const GOOD = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a well-formed, existing, used address.
  chainValues.ETH.isValidAddress.mockReturnValue(true);
  chainValues.SOL.isValidAddress.mockReturnValue(true);
  verifyAddressOnChain.mockResolvedValue({
    exists: true,
    active: true,
    source: "triverify",
  });
});

describe("verifyAddressExists — the happy path", () => {
  it("confirms a valid, existing, active address", async () => {
    const r = await verifyAddressExists(GOOD, "ETH");
    expect(r).toEqual({
      address: GOOD,
      chain: "ETH",
      formatValid: true,
      existsOnChain: true,
      active: true,
      source: "triverify",
      error: undefined,
    });
  });

  it("passes the chain to the adapter and lower-cases it for the verifier", async () => {
    await verifyAddressExists(GOOD, "ETH");
    expect(getChainAdapter).toHaveBeenCalledWith("ETH");
    // Uppercase 'ETH' out, lower-case 'eth' in — the two layers disagree on
    // case by design, and this pins the conversion.
    expect(verifyAddressOnChain).toHaveBeenCalledWith(GOOD, "eth");
  });

  it("reports an existing but never-used address as inactive", async () => {
    // The distinction transfer safety keys off, so it must survive the mapping.
    verifyAddressOnChain.mockResolvedValue({ exists: true, active: false, source: "s" });
    const r = await verifyAddressExists(GOOD, "ETH");
    expect(r.existsOnChain).toBe(true);
    expect(r.active).toBe(false);
  });

  it("works for a non-EVM chain too", async () => {
    const sol = "So11111111111111111111111111111111111111112";
    const r = await verifyAddressExists(sol, "SOL");
    expect(r.chain).toBe("SOL");
    expect(verifyAddressOnChain).toHaveBeenCalledWith(sol, "sol");
  });
});

describe("verifyAddressExists — a bad format never reaches the network", () => {
  it("returns formatValid:false without calling the verifier", async () => {
    chainValues.ETH.isValidAddress.mockReturnValue(false);
    const r = await verifyAddressExists("nonsense", "ETH");

    expect(r).toEqual({
      address: "nonsense",
      chain: "ETH",
      formatValid: false,
      existsOnChain: false,
      active: false,
      error: "invalid_address_format",
    });
    // The load-bearing assertion: no network call for a malformed address.
    expect(verifyAddressOnChain).not.toHaveBeenCalled();
  });

  it("does not throw for a bad format — it returns a negative result", async () => {
    // Deliberately different from the unverified case below. A malformed address
    // is a client typo the UI can explain; an unverifiable one is a blocked send.
    chainValues.ETH.isValidAddress.mockReturnValue(false);
    await expect(verifyAddressExists("nonsense", "ETH")).resolves.toMatchObject({
      formatValid: false,
    });
  });
});

describe("verifyAddressExists — an unverifiable address BLOCKS the send", () => {
  it("throws a 400 rather than returning existsOnChain:false", async () => {
    // The most important behaviour in this file. If this ever becomes a return
    // value instead of a throw, a caller that only checks `existsOnChain` would
    // treat an unverifiable address as a normal negative and the send could
    // proceed.
    verifyAddressOnChain.mockResolvedValue({
      exists: false,
      active: false,
      error: "rpc_timeout",
    });

    await expect(verifyAddressExists(GOOD, "ETH")).rejects.toMatchObject({
      statusCode: 400,
      message: "Address could not be verified on ETH",
    });
  });

  it("does not leak the underlying reason into the user-facing message", async () => {
    verifyAddressOnChain.mockResolvedValue({ exists: false, active: false, error: "rpc_timeout" });
    await expect(verifyAddressExists(GOOD, "ETH")).rejects.toThrow(
      /^Address could not be verified on ETH$/,
    );
  });

  it("blocks on exists:false even when the adapter said the format was fine", async () => {
    // Well-formed but unverifiable — an address nobody has ever touched, or one
    // the chain cannot answer for. Still a blocked send.
    chainValues.ETH.isValidAddress.mockReturnValue(true);
    verifyAddressOnChain.mockResolvedValue({ exists: false, active: false });
    await expect(verifyAddressExists(GOOD, "ETH")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("propagates a throw from the verifier unchanged", async () => {
    // A network-layer throw is not this function's to translate; swallowing it
    // into a generic message would hide a real outage.
    verifyAddressOnChain.mockRejectedValue(new Error("socket hang up"));
    await expect(verifyAddressExists(GOOD, "ETH")).rejects.toThrow("socket hang up");
  });
});

describe("verifyAddressExists — adapter failures", () => {
  it("propagates an unknown-chain failure from getChainAdapter", async () => {
    await expect(verifyAddressExists(GOOD, "NOPE" as "ETH")).rejects.toThrow(
      "no test adapter for NOPE",
    );
  });
});