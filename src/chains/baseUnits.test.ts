import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exact base-unit conversion, proven at the adapter boundary.
 *
 * `src/utils/money.test.ts` proves the conversion functions themselves. This
 * file proves the three non-EVM adapters actually USE them, because the bug
 * this guards against was not a wrong formula — it was the right arithmetic
 * performed on the wrong type. Each of these adapters previously did
 * `Math.round(Number(input.amount) * 10 ** d)` (outbound) and
 * `String(base / 10 ** d)` (inbound), both of which lose real value once an
 * amount is large enough to exhaust the float mantissa.
 *
 * The vendor SDKs are mocked, so no network is touched. TON is the strictest
 * case: its client returns balances as `bigint`, so it exercises the inbound
 * direction with a value a float provably cannot represent.
 */

const { envState, mocks } = vi.hoisted(() => ({
  envState: {
    env: {
      SOLANA_RPC_URL: "https://sol.invalid",
      TRON_RPC_URL: "https://tron.invalid",
      TON_RPC_URL: "https://ton.invalid",
      LOG_LEVEL: "silent",
    },
  },
  mocks: {
    getBalance: vi.fn(),
    getLatestBlockhash: vi.fn(),
    getFeeForMessage: vi.fn(),
    trxGetBalance: vi.fn(),
    sendTrx: vi.fn(),
    tonGetBalance: vi.fn(),
  },
}));

vi.mock("../config/env.js", () => ({ env: envState.env }));

vi.mock("@solana/web3.js", () => {
  // Only the pieces the adapter touches; `PublicKey` is a pass-through string.
  class PublicKey {
    constructor(public key: string) {}
    toString() { return this.key; }
  }
  const SystemProgram = {
    transfer: (args: { lamports: unknown }) => ({ instruction: "transfer", args }),
  };
  return {
    PublicKey,
    SystemProgram,
    Connection: class {
      getBalance = mocks.getBalance;
      getLatestBlockhash = mocks.getLatestBlockhash;
      getFeeForMessage = mocks.getFeeForMessage;
      sendRawTransaction = vi.fn();
      getSignatureStatuses = vi.fn();
    },
    Transaction: class {
      instructions: unknown[] = [];
      constructor(public opts: unknown) {}
      add(i: unknown) { this.instructions.push(i); return this; }
      compileMessage() { return { compiled: true }; }
    },
  };
});

vi.mock("tronweb", () => ({
  TronWeb: class {
    trx = {
      getBalance: mocks.trxGetBalance,
      sendRawTransaction: vi.fn(),
      getTransactionInfo: vi.fn(),
    };
    transactionBuilder = { sendTrx: mocks.sendTrx };
  },
}));

vi.mock("@ton/ton", () => ({
  TonClient: class {
    getBalance = mocks.tonGetBalance;
    sendFile = vi.fn();
  },
  Address: { parse: (a: string) => ({ toRawString: () => a }) },
}));

import { solanaAdapter } from "./solana/index.js";
import { tonAdapter } from "./ton/index.js";
import { tronAdapter } from "./tron/index.js";

const SOL_ADDR_A = "So11111111111111111111111111111111111111112";
const SOL_ADDR_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TRON_ADDR_A = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const TRON_ADDR_B = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj";
const TON_ADDR_A = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const TON_ADDR_B = "EQAv__________________________________________0vo";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "bh" });
});

describe("Solana adapter converts lamports exactly", () => {
  it("builds a transfer with the exact lamport count for a large amount", async () => {
    // Outbound is a plain string -> bigint conversion, so it has no 2^53
    // ceiling at all: this is the direction that decides how much moves.
    const tx = await solanaAdapter.buildTransaction({
      asset: "SOL", amount: "707273841233.73715227",
      toAddress: SOL_ADDR_B, fromAddress: SOL_ADDR_A,
    });
    // The float path produced 707273841233737200000 here; the exact value is
    // 47730 lamports higher.
    const instruction = (tx as { instructions: [{ args: { lamports: bigint } }] }).instructions[0];
    expect(instruction.args.lamports).toBe(707_273_841_233_737_152_270n);
  });

  it("converts the smallest representable amount to exactly 1 lamport", async () => {
    const tx = await solanaAdapter.buildTransaction({
      asset: "SOL", amount: "0.000000001", toAddress: SOL_ADDR_B, fromAddress: SOL_ADDR_A,
    });
    const instruction = (tx as { instructions: [{ args: { lamports: bigint } }] }).instructions[0];
    expect(instruction.args.lamports).toBe(1n);
  });

  it("reads a balance back without losing the fractional part", async () => {
    // 1_000_000_000_000_001 lamports. `String(base / 1e9)` printed
    // "1000000" and dropped the fraction entirely.
    mocks.getBalance.mockResolvedValue(1_000_000_000_000_001);
    expect(await solanaAdapter.getBalance(SOL_ADDR_A)).toBe("1000000.000000001");
  });

  it("is exact across the whole range the SDK's number type can hold", async () => {
    // `Connection.getBalance` returns lamports as a JS `number`, so 2^53
    // (9_007_199_254_740_992 lamports, about 9.0e6 SOL) is the ceiling on what
    // this read path can represent. That is the vendor SDK's contract, not a
    // choice made here, and it is recorded rather than hidden: everything at or
    // below the ceiling converts exactly.
    const TWO_53 = 2 ** 53;
    mocks.getBalance.mockResolvedValue(TWO_53);
    expect(await solanaAdapter.getBalance(SOL_ADDR_A)).toBe("9007199.254740992");
    mocks.getBalance.mockResolvedValue(1);
    expect(await solanaAdapter.getBalance(SOL_ADDR_A)).toBe("0.000000001");
  });

  it("reads a zero balance as '0', not '0.0'", async () => {
    mocks.getBalance.mockResolvedValue(0);
    expect(await solanaAdapter.getBalance(SOL_ADDR_A)).toBe("0");
  });

  it("accepts the chain's own symbol as the native asset", async () => {
    mocks.getBalance.mockResolvedValue(1_500_000_000);
    expect(await solanaAdapter.getBalance(SOL_ADDR_A, "SOL")).toBe("1.5");
  });

  it("still rejects a token that is not configured at all", async () => {
    // Not-implemented is gone; genuinely-unsupported is not. (The positive SPL
    // path needs the real PublicKey, so it is covered in spl.adapter.test.ts
    // rather than against this file's deliberately partial SDK mock.)
    await expect(solanaAdapter.getBalance(SOL_ADDR_A, "NOTAREALTOKEN")).rejects.toThrow(/Unsupported SPL token/);
  });
});

describe("TRON adapter converts sun exactly", () => {
  it("builds a transfer with the exact sun count", async () => {
    mocks.sendTrx.mockReturnValue({});
    // Found by sweeping inputs below the SDK's 2^53 ceiling for ones the old
    // `Math.round(Number(x) * 1e6)` got wrong: this one was off by one sun.
    await tronAdapter.buildTransaction({
      asset: "TRX", amount: "4485337974.43", toAddress: TRON_ADDR_B, fromAddress: TRON_ADDR_A,
    });
    expect(mocks.sendTrx).toHaveBeenCalledWith(TRON_ADDR_B, 4_485_337_974_430_000, TRON_ADDR_A);
  });

  it("refuses an amount tronweb's number-typed sendTrx could not carry exactly", async () => {
    // `sendTrx` takes a `number`, so above 2^53 sun the amount would silently
    // change. The adapter must refuse rather than build a transaction for a
    // different value than the user asked for. 2^53 sun is about
    // 9,007,199,254 TRX, so this is a real ceiling, not a theoretical one.
    mocks.sendTrx.mockReturnValue({});
    await expect(tronAdapter.buildTransaction({
      asset: "TRX", amount: "9007199255", toAddress: TRON_ADDR_B, fromAddress: TRON_ADDR_A,
    })).rejects.toThrow(/exact range/);
    expect(mocks.sendTrx).not.toHaveBeenCalled();
  });

  it("still accepts the largest amount that IS exactly representable", async () => {
    mocks.sendTrx.mockReturnValue({});
    // 2^53-1 sun = 9,007,199,254.740991 TRX: the ceiling itself must work.
    await tronAdapter.buildTransaction({
      asset: "TRX", amount: "9007199254.740991", toAddress: TRON_ADDR_B, fromAddress: TRON_ADDR_A,
    });
    expect(mocks.sendTrx).toHaveBeenCalledWith(TRON_ADDR_B, 9_007_199_254_740_991, TRON_ADDR_A);
  });

  it("converts the smallest representable amount to exactly 1 sun", async () => {
    mocks.sendTrx.mockReturnValue({});
    await tronAdapter.buildTransaction({
      asset: "TRX", amount: "0.000001", toAddress: TRON_ADDR_B, fromAddress: TRON_ADDR_A,
    });
    expect(mocks.sendTrx).toHaveBeenCalledWith(TRON_ADDR_B, 1, TRON_ADDR_A);
  });

  it("reads a balance back without losing the fractional part", async () => {
    mocks.trxGetBalance.mockResolvedValue(12_345_678_123_456);
    expect(await tronAdapter.getBalance(TRON_ADDR_A)).toBe("12345678.123456");
  });

  it("is exact across the range the SDK's number type can hold", async () => {
    // `trx.getBalance` returns sun as a JS `number`, so the ceiling is 2^53 sun
    // (about 9.0e9 TRX). The entire plausible TRX supply (about 1e8 TRX) sits
    // well below it, so this read path is exact in practice.
    mocks.trxGetBalance.mockResolvedValue(2 ** 53);
    expect(await tronAdapter.getBalance(TRON_ADDR_A)).toBe("9007199254.740992");
    mocks.trxGetBalance.mockResolvedValue(1);
    expect(await tronAdapter.getBalance(TRON_ADDR_A)).toBe("0.000001");
  });

  it("accepts the chain's own symbol as the native asset", async () => {
    mocks.trxGetBalance.mockResolvedValue(2_000_000);
    expect(await tronAdapter.getBalance(TRON_ADDR_A, "TRX")).toBe("2");
  });
});

describe("TON adapter converts nanotokens exactly", () => {
  it("builds a transfer with the exact nanoton count", async () => {
    const plan = await tonAdapter.buildTransaction({
      asset: "TON", amount: "21000000.000000001", toAddress: TON_ADDR_B, fromAddress: TON_ADDR_A,
    });
    // The float path produced 21000000000000000, one nanoton short.
    expect(plan).toEqual({ to: TON_ADDR_B, amountNano: "21000000000000001" });
  });

  it("reads a bigint balance back without dropping the fraction", async () => {
    // `TonClient.getBalance` returns a bigint, so unlike Solana and TRON this
    // path has no 2^53 ceiling. This is the case the old float division
    // destroyed outright: it rendered "21000000", losing 1 nanoton.
    mocks.tonGetBalance.mockResolvedValue(21_000_000_000_000_001n);
    expect(await tonAdapter.getBalance(TON_ADDR_A)).toBe("21000000.000000001");
  });

  it("is exact far above the 2^53 range, because the SDK returns a bigint", async () => {
    mocks.tonGetBalance.mockResolvedValue(9_007_199_254_740_993n); // 2^53 + 1
    expect(await tonAdapter.getBalance(TON_ADDR_A)).toBe("9007199.254740993");
  });

  it("reads a zero balance as '0', not '0.0'", async () => {
    mocks.tonGetBalance.mockResolvedValue(0n);
    expect(await tonAdapter.getBalance(TON_ADDR_A)).toBe("0");
  });

  it("accepts the chain's own symbol as the native asset", async () => {
    mocks.tonGetBalance.mockResolvedValue(3_000_000_000n);
    expect(await tonAdapter.getBalance(TON_ADDR_A, "TON")).toBe("3");
  });
});
