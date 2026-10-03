import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SolanaWeb3 from "@solana/web3.js";

/**
 * The SPL path through the Solana adapter.
 *
 * `src/chains/solana/spl.test.ts` proves the instruction ENCODING, against the
 * real web3.js. This file proves the adapter WIRES it up correctly: that a token
 * symbol is dispatched to the token reader, that a never-held token reads as
 * zero, and that a transfer to a first-time recipient includes the
 * associated-account creation.
 *
 * Only `Connection` is stubbed. `PublicKey` and the PDA derivation are left
 * real, because they are the part that has to be right for an address to be
 * correct — a mocked `PublicKey` proved nothing (and, in this repo's history,
 * exactly such a mock hid a real runtime break).
 */
const { mocks, envState } = vi.hoisted(() => ({
  envState: {
    env: {
      SOLANA_RPC_URL: "https://sol.invalid",
      SOLANA_CLUSTER: "devnet",
      SOLANA_SPL_TOKENS: undefined as string | undefined,
      LOG_LEVEL: "silent",
    },
  },
  mocks: {
    getBalance: vi.fn(),
    getAccountInfo: vi.fn(),
    getLatestBlockhash: vi.fn(),
    getFeeForMessage: vi.fn(),
  },
}));

vi.mock("../../config/env.js", () => ({ env: envState.env }));
vi.mock("../../config/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

// Partial mock: keep the real PublicKey / Transaction / findProgramAddressSync,
// replace only the network client.
vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SolanaWeb3>();
  return {
    ...actual,
    Connection: class {
      getBalance = mocks.getBalance;
      getAccountInfo = mocks.getAccountInfo;
      getLatestBlockhash = mocks.getLatestBlockhash;
      getFeeForMessage = mocks.getFeeForMessage;
      sendRawTransaction = vi.fn();
      getSignatureStatuses = vi.fn();
    },
  };
});

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

import { solanaAdapter } from "./index.js";
import { associatedTokenAddress, isTokenAccountSize } from "./spl.js";
import { listSplTokens, requireSplToken, resetSplTokenOverrides, resolveSplToken } from "./tokens.js";
import { PublicKey } from "@solana/web3.js";

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TO = "So11111111111111111111111111111111111111112";

/** A 165-byte token account with `amount` base units. */
function tokenAccount(amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getLatestBlockhash.mockResolvedValue({ blockhash: "bh" });
  mocks.getFeeForMessage.mockResolvedValue({ value: 5000 });
  envState.env.SOLANA_SPL_TOKENS = undefined;
  resetSplTokenOverrides();
});

describe("the SPL registry", () => {
  it("exposes the verified devnet USDC, and no unconfigured token", () => {
    expect(listSplTokens().map((t) => t.symbol)).toEqual(["USDC"]);
    expect(resolveSplToken("usdc")?.address).toBe(USDC);
    expect(resolveSplToken("NOPE")).toBeNull();
  });

  it("names what IS available when a token is unknown", () => {
    expect(() => requireSplToken("NOPE")).toThrow(/Configured on devnet: USDC/);
  });

  it("accepts a well-formed SOLANA_SPL_TOKENS override", () => {
    envState.env.SOLANA_SPL_TOKENS = JSON.stringify([
      { symbol: "USDT", name: "Tether USD", decimals: 6, address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
    ]);
    resetSplTokenOverrides();
    expect(resolveSplToken("USDT")?.decimals).toBe(6);
  });

  it("drops a malformed override but keeps the verified seeds", () => {
    // A bad entry must not take the API down, and must not silently widen.
    envState.env.SOLANA_SPL_TOKENS = JSON.stringify([{ symbol: "BAD", address: "not-base58!" }]);
    resetSplTokenOverrides();
    expect(listSplTokens().map((t) => t.symbol)).toEqual(["USDC"]);
  });

  it("rejects an override whose decimals exceed the ledger's 18", () => {
    envState.env.SOLANA_SPL_TOKENS = JSON.stringify([
      { symbol: "X", name: "X", decimals: 19, address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
    ]);
    resetSplTokenOverrides();
    expect(listSplTokens().map((t) => t.symbol)).toEqual(["USDC"]);
  });
});

describe("the adapter's SPL surface", () => {
  it("lists and resolves tokens in the EVM adapter's shape", () => {
    const listed = solanaAdapter.listTokens!();
    expect(listed[0]).toEqual({ symbol: "USDC", name: "USD Coin", decimals: 6, address: USDC });
    expect(solanaAdapter.resolveToken!("USDC")?.decimals).toBe(6);
  });

  it("reads a token balance at the mint's own decimals, exactly", async () => {
    // 1_234_567 base units at 6 decimals is 1.234567 USDC. A float path would
    // render this as 1.2345670000000002 or similar.
    mocks.getAccountInfo.mockResolvedValue({ data: tokenAccount(1_234_567n) });
    expect(await solanaAdapter.getTokenBalance!(OWNER, "USDC")).toBe("1.234567");
  });

  it("treats a token the address has never held as zero, not an error", async () => {
    // "New user, first transfer" must not fail on a missing account.
    mocks.getAccountInfo.mockResolvedValue(null);
    expect(await solanaAdapter.getTokenBalance!(OWNER, "USDC")).toBe("0");
  });

  it("reads the balance from the DERIVED associated account, not the owner's wallet", async () => {
    mocks.getAccountInfo.mockResolvedValue({ data: tokenAccount(7n) });
    await solanaAdapter.getTokenBalance!(OWNER, "USDC");
    const asked = mocks.getAccountInfo.mock.calls[0][0] as PublicKey;
    expect(asked.toBase58()).toBe(associatedTokenAddress(new PublicKey(USDC), new PublicKey(OWNER)).toBase58());
  });

  it("refuses to report a balance from something that is not a token account", async () => {
    // Reading a u64 at offset 64 of the wrong buffer yields a plausible wrong
    // number, which is the failure mode the length check exists to prevent.
    mocks.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(100) });
    expect(isTokenAccountSize(Buffer.alloc(100))).toBe(false);
    await expect(solanaAdapter.getTokenBalance!(OWNER, "USDC")).rejects.toThrow(/not a token account/);
  });

  it("routes a token symbol on getBalance to the token reader", async () => {
    mocks.getAccountInfo.mockResolvedValue({ data: tokenAccount(2_000_000n) });
    expect(await solanaAdapter.getBalance(OWNER, "USDC")).toBe("2");
    // and leaves the native path on getBalance alone
    mocks.getBalance.mockResolvedValue(1_500_000_000);
    expect(await solanaAdapter.getBalance(OWNER, "SOL")).toBe("1.5");
  });
});

describe("SPL transfer construction", () => {
  it("adds the associated-account creation when the recipient has none", async () => {
    mocks.getAccountInfo.mockResolvedValue(null);
    const tx = await solanaAdapter.buildTransaction({
      asset: "USDC", amount: "1.5", fromAddress: OWNER, toAddress: TO,
    }) as { instructions: { programId: PublicKey }[] };
    const programs = tx.instructions.map((i) => i.programId.toBase58());
    // Exactly two instructions: create the recipient's account, then transfer.
    expect(programs).toEqual([ATA_PROGRAM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
  });

  it("omits the creation when the recipient already has a token account", async () => {
    // A second payment to the same person must not carry a redundant, and
    // legacy-form, account creation.
    mocks.getAccountInfo.mockResolvedValue({ data: tokenAccount(0n) });
    const tx = await solanaAdapter.buildTransaction({
      asset: "USDC", amount: "1.5", fromAddress: OWNER, toAddress: TO,
    }) as { instructions: { programId: PublicKey }[] };
    expect(tx.instructions).toHaveLength(1);
  });

  it("encodes the amount at the MINT's decimals, not the native 9", async () => {
    mocks.getAccountInfo.mockResolvedValue({ data: tokenAccount(0n) });
    const tx = await solanaAdapter.buildTransaction({
      asset: "USDC", amount: "1.5", fromAddress: OWNER, toAddress: TO,
    }) as { instructions: { data: Buffer; programId: PublicKey }[] };
    const transfer = tx.instructions.find((i) => i.programId.toBase58() !== ATA_PROGRAM)!;
    // 1.5 USDC at 6 decimals is 1_500_000. At the native 9 it would be
    // 1_500_000_000 — a 1000x overpayment the program would happily execute.
    expect(transfer.data.readBigUInt64LE(1)).toBe(1_500_000n);
  });

  it("still builds a native SOL transfer through SystemProgram", async () => {
    mocks.getAccountInfo.mockResolvedValue({ data: tokenAccount(0n) });
    const tx = await solanaAdapter.buildTransaction({
      asset: "SOL", amount: "0.5", fromAddress: OWNER, toAddress: TO,
    }) as { instructions: { programId: PublicKey }[] };
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0].programId.toBase58()).toBe("11111111111111111111111111111111");
  });

  it("refuses an unconfigured token rather than guessing a mint", async () => {
    await expect(solanaAdapter.buildTransaction({
      asset: "NOPE", amount: "1", fromAddress: OWNER, toAddress: TO,
    })).rejects.toThrow(/Unsupported SPL token/);
  });
});

describe("canPayGas", () => {
  it("requires the token-account rent, not just the signature fee", async () => {
    // A transfer to a first-time recipient needs rent (1_488_440) plus the
    // signature fee (5_000) on top of whatever the caller stated. 1_200_000
    // covers a 0.001 SOL fee comfortably but NOT the rent, so a check that only
    // looked at the fee would wrongly pass here and then fail on-chain.
    mocks.getBalance.mockResolvedValue(1_200_000);
    expect(await solanaAdapter.canPayGas!(OWNER, "0.001")).toBe(false);
  });

  it("passes once the balance covers rent plus the signature fee", async () => {
    mocks.getBalance.mockResolvedValue(Number(3_000_000n));
    expect(await solanaAdapter.canPayGas!(OWNER, "0.001")).toBe(true);
  });

  it("uses the larger of the stated amount and the rent floor", async () => {
    mocks.getBalance.mockResolvedValue(Number(1_500_000n));
    expect(await solanaAdapter.canPayGas!(OWNER, "0.01")).toBe(false);
  });
});
