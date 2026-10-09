import { isAddress } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Address existence verification — the layer that decides whether a Send is
// allowed to proceed to an address. It had no tests at all.
//
// The property that matters is FAIL-CLOSED. Every path here returns a result
// object rather than throwing, so the dangerous shape is a caller that reads a
// truthy field off an error result. Concretely, the three ways this can go
// wrong and lose someone money:
//
//   1. an RPC failure reported as `exists: true`  -> a dead address looks live
//   2. a timeout reported as a live balance       -> funds "sent" into the void
//   3. a malformed address treated as valid       -> the send proceeds at all
//
// So the assertions below are mostly about what happens when things FAIL. The
// success cases matter too, but they are the easy half.
//
// The provider is mocked, never the network: ethers' JsonRpcProvider is stubbed
// at the module boundary so these tests cannot pass or fail on RPC uptime.
// ---------------------------------------------------------------------------

const { providerMock, mocks } = vi.hoisted(() => {
  const providerMock = {
    getCode: vi.fn(),
    getTransactionCount: vi.fn(),
    getBalance: vi.fn(),
  };
  return {
    providerMock,
    // A class, not an arrow fn: evmFallback does `new JsonRpcProvider(...)`,
    // and `vi.fn(() => x)` is not constructible.
    mocks: { JsonRpcProvider: vi.fn(function (this: unknown) { return providerMock; }) },
  };
});

// Only `isAddress` and `JsonRpcProvider` are needed, and only the provider is
// replaced. Spreading the real module keeps `isAddress` genuine, which is what
// lets the suite assert the implementation agrees with ethers rather than with
// a mock of itself.
vi.mock("ethers", async (importOriginal) => {
  const actual: object = await importOriginal();
  return { ...actual, JsonRpcProvider: mocks.JsonRpcProvider };
});

const { verifyOnChainFallback } = await import("./evmFallback.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const CONTRACT = "0x2222222222222222222222222222222222222222";
const BAD = "not-an-address";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a funded, previously-used EOA.
  providerMock.getCode.mockResolvedValue("0x");
  providerMock.getTransactionCount.mockResolvedValue(3);
  providerMock.getBalance.mockResolvedValue(1_000_000_000_000_000_000n);
});

describe("verifyOnChainFallback — success shapes", () => {
  it("reports a used EOA as an existing active wallet", async () => {
    const r = await verifyOnChainFallback(WALLET, "bsc");
    expect(r).toMatchObject({
      address: WALLET,
      chain: "bsc",
      exists: true,
      active: true,
      type: "wallet",
      transactionCount: 3,
      balance: "1000000000000000000",
      supported: true,
    });
    expect(r.error).toBeUndefined();
  });

  it("reports an address with code as a contract", async () => {
    providerMock.getCode.mockResolvedValue("0x60806040");
    const r = await verifyOnChainFallback(CONTRACT, "base");
    expect(r.type).toBe("contract");
    expect(r.exists).toBe(true);
    // A contract is "active" even with no balance and no history.
    providerMock.getBalance.mockResolvedValue(0n);
    providerMock.getTransactionCount.mockResolvedValue(0);
    expect((await verifyOnChainFallback(CONTRACT, "base")).active).toBe(true);
  });

  it("calls the chain's own default RPC when none is supplied", async () => {
    await verifyOnChainFallback(WALLET, "base");
    expect(mocks.JsonRpcProvider).toHaveBeenCalledWith("https://mainnet.base.org");
    await verifyOnChainFallback(WALLET, "bsc");
    expect(mocks.JsonRpcProvider).toHaveBeenCalledWith("https://bsc-dataseed.binance.org");
  });

  it("prefers an explicit rpcUrl over the default", async () => {
    const r = await verifyOnChainFallback(WALLET, "bsc", { rpcUrl: "https://rpc.example" });
    expect(mocks.JsonRpcProvider).toHaveBeenCalledWith("https://rpc.example");
    expect(r.source).toBe("https://rpc.example");
  });

  it("returns balance as an exact decimal string, never a float", async () => {
    // A wei value that is not representable as a JS number. If any code path
    // did Number(balance) this would come back wrong, and this is a 1:1
    // transfer so the difference is the user's money.
    providerMock.getBalance.mockResolvedValue(123456789012345678901n);
    const r = await verifyOnChainFallback(WALLET, "eth" as "bsc");
    expect(r.balance).toBe("123456789012345678901");
  });
});

describe("verifyOnChainFallback — fail-closed", () => {
  it("never touches the network for a malformed address", async () => {
    const r = await verifyOnChainFallback(BAD, "bsc");
    expect(r).toMatchObject({ exists: false, active: false, type: "unknown" });
    expect(r.error).toBe("invalid_address_format");
    // No RPC call at all — a bad address is rejected locally, not looked up.
    expect(mocks.JsonRpcProvider).not.toHaveBeenCalled();
    expect(providerMock.getCode).not.toHaveBeenCalled();
  });

  it("reports exists:false when the RPC throws — never a live-looking result", async () => {
    providerMock.getCode.mockRejectedValue(new Error("503 Service Unavailable"));
    const r = await verifyOnChainFallback(WALLET, "bsc");
    // The load-bearing assertion of this file.
    expect(r.exists).toBe(false);
    expect(r.active).toBe(false);
    expect(r.balance).toBeUndefined();
    expect(r.transactionCount).toBeUndefined();
    expect(r.error).toContain("503");
  });

  it("fails closed on a timeout rather than hanging or half-answering", async () => {
    // Never resolves, so only the timeout can end the call.
    providerMock.getCode.mockReturnValue(new Promise(() => {}));
    providerMock.getTransactionCount.mockReturnValue(new Promise(() => {}));
    providerMock.getBalance.mockReturnValue(new Promise(() => {}));

    const r = await verifyOnChainFallback(WALLET, "base", { timeoutMs: 40 });
    expect(r.exists).toBe(false);
    expect(r.active).toBe(false);
    expect(r.error).toBe("rpc_timeout");
  }, 5_000);

  it("fails closed when only ONE of the three calls rejects", async () => {
    // Promise.all rejects on the first failure; a partial answer must not leak
    // through as a verified address.
    providerMock.getBalance.mockRejectedValue(new Error("boom"));
    const r = await verifyOnChainFallback(WALLET, "bsc");
    expect(r.exists).toBe(false);
    expect(r.balance).toBeUndefined();
  });

  it("uses a non-Error rejection without leaking undefined into error", async () => {
    providerMock.getCode.mockRejectedValue("just a string");
    const r = await verifyOnChainFallback(WALLET, "bsc");
    expect(r.exists).toBe(false);
    expect(r.error).toBe("rpc_error");
  });
});

describe("verifyOnChainFallback — the active calculation", () => {
  it("treats a never-used, zero-balance EOA as existing but inactive", async () => {
    providerMock.getTransactionCount.mockResolvedValue(0);
    providerMock.getBalance.mockResolvedValue(0n);
    providerMock.getCode.mockResolvedValue("0x");

    const r = await verifyOnChainFallback(WALLET, "bsc");
    // It EXISTS (well-formed, RPC answered) but has never been used. Callers
    // key transfer safety off `active`, so this distinction is load-bearing.
    expect(r.exists).toBe(true);
    expect(r.active).toBe(false);
    expect(r.type).toBe("wallet");
  });

  it("is active on a non-zero balance alone", async () => {
    providerMock.getTransactionCount.mockResolvedValue(0);
    providerMock.getBalance.mockResolvedValue(1n);
    expect((await verifyOnChainFallback(WALLET, "bsc")).active).toBe(true);
  });

  it("is active on transaction history alone", async () => {
    providerMock.getTransactionCount.mockResolvedValue(1);
    providerMock.getBalance.mockResolvedValue(0n);
    expect((await verifyOnChainFallback(WALLET, "bsc")).active).toBe(true);
  });

  it("compares code against '0x' exactly, not for truthiness", async () => {
    // The code is `code !== '0x'`, so '0x0' / '0x00' — zero-length code that
    // some clients pad differently — are classified as CONTRACTS. That is the
    // real behaviour, so it is pinned here rather than asserted as correct: a
    // provider that pads would flip every EOA to `contract`, and anyone reading
    // this test later needs to see that the comparison is exact.
    providerMock.getTransactionCount.mockResolvedValue(0);
    providerMock.getBalance.mockResolvedValue(0n);

    for (const padded of ["0x0", "0x00"]) {
      providerMock.getCode.mockResolvedValue(padded);
      expect((await verifyOnChainFallback(WALLET, "bsc")).type).toBe("contract");
    }

    providerMock.getCode.mockResolvedValue("0x");
    expect((await verifyOnChainFallback(WALLET, "bsc")).type).toBe("wallet");

    providerMock.getCode.mockResolvedValue("0x01");
    expect((await verifyOnChainFallback(WALLET, "bsc")).type).toBe("contract");
  });
});

describe("verifyOnChainFallback — ethers agreement", () => {
  it("accepts exactly the addresses ethers accepts", async () => {
    // Guards against the module mocking the very predicate under test.
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const lower = checksummed.toLowerCase();
    const badChecksum = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeD"; // wrong case

    expect(isAddress(checksummed)).toBe(true);
    expect(isAddress(lower)).toBe(true);
    expect(isAddress(badChecksum)).toBe(false);

    for (const a of [checksummed, lower]) {
      const r = await verifyOnChainFallback(a, "bsc");
      expect(r.exists).toBe(true);
    }
    expect((await verifyOnChainFallback(badChecksum, "bsc")).error).toBe("invalid_address_format");
  });

  it("rejects a 39-character address (off by one)", async () => {
    const short = "0x" + "1".repeat(39);
    expect(isAddress(short)).toBe(false);
    expect((await verifyOnChainFallback(short, "bsc")).exists).toBe(false);
  });
});