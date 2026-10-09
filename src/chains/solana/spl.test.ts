import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { toBaseUnits } from "../../utils/money.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  associatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  isTokenAccountSize,
  readTokenAccountAmount,
  tokenProgramId,
} from "./spl.js";
import { clusterFromRpcUrl } from "./tokens.js";

/**
 * SPL instruction encoding.
 *
 * The layout is fixed by the on-chain program, so these are exact-shape tests
 * rather than behavioural ones: a wrong discriminator, a swapped field, or a
 * little-endian/big-endian slip would all still "work" as a Buffer and would
 * move the wrong money. `scripts/verify-solana-spl.ts` proves the same bytes are
 * accepted by a real Devnet validator.
 */

const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const owner = Keypair.generate();
const recipient = Keypair.generate();

describe("program ids", () => {
  it("are the published constants, not token addresses", () => {
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(TOKEN_2022_PROGRAM_ID.toBase58()).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });

  it("selects the right program per token type", () => {
    expect(tokenProgramId("spl-token").toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(tokenProgramId("token-2022").toBase58()).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
  });
});

describe("associatedTokenAddress", () => {
  it("is a deterministic function of owner, program and mint", () => {
    const a = associatedTokenAddress(mint, owner.publicKey);
    const b = associatedTokenAddress(mint, owner.publicKey);
    expect(a.toBase58()).toBe(b.toBase58());
  });

  it("differs per owner", () => {
    expect(associatedTokenAddress(mint, owner.publicKey).toBase58())
      .not.toBe(associatedTokenAddress(mint, recipient.publicKey).toBase58());
  });

  it("differs per mint", () => {
    const other = new PublicKey("So11111111111111111111111111111111111111112");
    expect(associatedTokenAddress(mint, owner.publicKey).toBase58())
      .not.toBe(associatedTokenAddress(other, owner.publicKey).toBase58());
  });

  it("differs per token program, because Token-2022 mints get their own accounts", () => {
    expect(associatedTokenAddress(mint, owner.publicKey, "spl-token").toBase58())
      .not.toBe(associatedTokenAddress(mint, owner.publicKey, "token-2022").toBase58());
  });
});

describe("createTransferInstruction", () => {
  const build = (amount: bigint, decimals = 6) =>
    createTransferInstruction({
      mint,
      source: associatedTokenAddress(mint, owner.publicKey),
      destination: associatedTokenAddress(mint, recipient.publicKey),
      owner: owner.publicKey,
      amount,
      decimals,
      program: "spl-token",
    });

  it("emits exactly tag + u64 amount + u8 decimals", () => {
    expect(build(1n).data.length).toBe(1 + 8 + 1);
  });

  it("uses instruction index 12 for TransferChecked, NOT 9 for Transfer", () => {
    // The legacy `Transfer` (9) is REJECTED by the current token program with
    // custom error 0xb. Measured by broadcasting both forms against a local
    // validator with a funded source. Do not "simplify" this back to 9.
    expect(build(1n).data[0]).toBe(12);
  });

  it("carries the decimals as the trailing byte, which the program verifies", () => {
    expect(build(1n, 6).data[9]).toBe(6);
    expect(build(1n, 9).data[9]).toBe(9);
    expect(build(1n, 0).data[9]).toBe(0);
  });

  it("puts the amount in bytes 1-8, little-endian, and nothing else", () => {
    // The pubkeys are NOT in the data. That was the original bug: the old
    // encoding packed source/destination/owner into 129 bytes of data and the
    // program parsed them positionally, so the layout was wrong twice over.
    const ix = build(1_500_000n);
    expect(ix.data.readBigUInt64LE(1)).toBe(1_500_000n);
    expect(ix.data.length).toBe(10);
  });

  it("writes the amount LITTLE-endian, as the program requires", () => {
    // 0x0102 = 258. Little-endian puts 0x01 first; big-endian would not.
    const data = build(258n).data;
    expect(data[1]).toBe(0x02);
    expect(data[2]).toBe(0x01);
    expect(data.readBigUInt64LE(1)).toBe(258n);
  });

  it("passes the mint as a read-only ACCOUNT, not as data", () => {
    // The mint is account index 1 and must not be writable: the token program
    // rejects a writable mint for this instruction.
    const ix = build(1n);
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[1].pubkey.equals(mint)).toBe(true);
    expect(ix.keys[1].isWritable).toBe(false);
    expect(ix.keys[1].isSigner).toBe(false);
  });

  it.each([-1, 256, 6.5, Number.NaN])(
    "refuses decimals %s, which cannot be encoded as a u8",
    (bad) => {
      // A wrong decimals value here is a silent 1-vs-6 token-amount error, so it
      // must be refused at construction rather than written into the instruction.
      expect(() => build(1n, bad)).toThrow(RangeError);
    },
  );

  it("marks source and destination writable, and owner as a non-writable signer", () => {
    // 4 accounts now: [source (w), mint (r), destination (w), owner (s)].
    const ix = build(1n);
    expect(ix.keys).toHaveLength(4);
    expect(ix.keys[0]).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix.keys[1]).toMatchObject({ isWritable: false, isSigner: false });
    expect(ix.keys[2]).toMatchObject({ isWritable: true, isSigner: false });
    expect(ix.keys[3]).toMatchObject({ isWritable: false, isSigner: true });
  });

  it("refuses a negative amount rather than wrapping it", () => {
    expect(() => build(-1n)).toThrow(/negative/);
  });

  it("refuses an amount above u64 rather than truncating it", () => {
    // Truncation here would be a silent wrong-amount transfer.
    expect(() => build(0x1_0000_0000_0000_0000n)).toThrow(/u64/);
    expect(() => build(0xffff_ffff_ffff_ffffn)).not.toThrow();
  });

  it("converts the token's own decimals exactly, not the native 9", () => {
    // The most damaging SPL bug available. The SAME raw bigint means a wildly
    // different amount at a different decimals:
    //   1_000_000 base units at 6 decimals = 1 USDC
    //   1_000_000 base units at 9 decimals = 0.001 USDC
    // Using the native 9 for a 6-decimal mint transfers 1000x too little, and
    // the program would execute it without complaint.
    const oneUsdc = toBaseUnits("1", 6);
    const oneUsdcAsNative = toBaseUnits("1", 9);
    expect(oneUsdc).toBe(1_000_000n);
    expect(oneUsdcAsNative).toBe(1_000_000_000n);

    expect(build(oneUsdc).data.readBigUInt64LE(1)).toBe(1_000_000n);
    // The same decimal string, misread at the native decimals, is 1000x larger.
    expect(build(toBaseUnits("1", 9)).data.readBigUInt64LE(1)).toBe(1_000_000_000n);

    // And the smallest representable amount survives the round trip at both.
    expect(build(toBaseUnits("0.000001", 6)).data.readBigUInt64LE(1)).toBe(1n);
  });
});

describe("createAssociatedTokenAccountInstruction", () => {
  it("is idempotent by default, so paying a repeat recipient cannot fail", () => {
    // Discriminant 1 is the idempotent form: a no-op if the account exists.
    // Without it, every second transfer to the same recipient would fail.
    const ix = createAssociatedTokenAccountInstruction({ funder: owner.publicKey, owner: recipient.publicKey, mint });
    expect(ix.data[0]).toBe(1);
    const legacy = createAssociatedTokenAccountInstruction({
      funder: owner.publicKey, owner: recipient.publicKey, mint, idempotent: false,
    });
    expect(legacy.data[0]).toBe(0);
  });

  it("sends ONE byte of data — the discriminant — and nothing else", () => {
    // This previously asserted a 129-byte payload carrying funder/ata/owner/mint
    // after the discriminant. Those values are all ACCOUNTS, and the program
    // reads them from `keys`, not from `data`; packing them in made every
    // instruction fail with a bare "invalid instruction data".
    //
    // Proven by dumping the instruction the official spl-token client builds
    // for the same owner/mint: its data is 1-2 bytes, ours was 129.
    const ix = createAssociatedTokenAccountInstruction({ funder: owner.publicKey, owner: recipient.publicKey, mint });
    expect(ix.data.length).toBe(1);
  });

  it("passes funder, ata, owner, mint, system and token program as ORDERED accounts", () => {
    // The key ORDER is the ABI. The rent sysvar used to sit where the token
    // program belongs, which the program rejected with "invalid instruction
    // data" — no field name, no hint that ordering was the problem.
    const ix = createAssociatedTokenAccountInstruction({ funder: owner.publicKey, owner: recipient.publicKey, mint });
    expect(ix.keys).toHaveLength(6);
    expect(ix.keys[0].pubkey.toBase58()).toBe(owner.publicKey.toBase58());
    expect(ix.keys[1].pubkey.toBase58()).toBe(associatedTokenAddress(mint, recipient.publicKey).toBase58());
    expect(ix.keys[2].pubkey.toBase58()).toBe(recipient.publicKey.toBase58());
    expect(ix.keys[3].pubkey.toBase58()).toBe(mint.toBase58());
    expect(ix.keys[4].pubkey.toBase58()).toBe(SYSTEM_PROGRAM_ID.toBase58());
    expect(ix.keys[5].pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    // The funder signs and pays; the rest are not signers.
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys.slice(1).every((k) => !k.isSigner)).toBe(true);
  });

  it("derives the same ATA the helper returns", () => {
    const ix = createAssociatedTokenAccountInstruction({ funder: owner.publicKey, owner: recipient.publicKey, mint });
    expect(ix.keys[1].pubkey.toBase58()).toBe(associatedTokenAddress(mint, recipient.publicKey).toBase58());
  });
});

describe("reading a token account", () => {
  it("reads a u64 little-endian at offset 64", () => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(1_234_567n, 64);
    expect(readTokenAccountAmount(data)).toBe(1_234_567n);
  });

  it("reads zero from a freshly-created, empty account", () => {
    expect(readTokenAccountAmount(Buffer.alloc(165))).toBe(0n);
  });

  it("REFUSES a truncated buffer instead of reading a plausible wrong number", () => {
    // The whole reason the length is checked: offset 64 exists in a 100-byte
    // buffer, and would silently return garbage.
    const short = Buffer.alloc(100);
    short.writeBigUInt64LE(999n, 64);
    expect(() => readTokenAccountAmount(short)).toThrow(/165/);
  });

  it("accepts a longer buffer, since the layout is a prefix", () => {
    const data = Buffer.alloc(200);
    data.writeBigUInt64LE(7n, 64);
    expect(readTokenAccountAmount(data)).toBe(7n);
  });

  it("identifies account-shaped data by size", () => {
    expect(isTokenAccountSize(Buffer.alloc(165))).toBe(true);
    expect(isTokenAccountSize(Buffer.alloc(164))).toBe(false);
    expect(isTokenAccountSize(null)).toBe(false);
  });
});

describe("clusterFromRpcUrl", () => {
  // Pure function, so these assertions do not depend on how the shell happened
  // to be configured — a test that reads ambient env passes or fails for the
  // wrong reason.
  it("reads the cluster from the RPC URL", () => {
    expect(clusterFromRpcUrl("https://api.devnet.solana.com")).toBe("devnet");
    expect(clusterFromRpcUrl("https://api.mainnet-beta.solana.com")).toBe("mainnet");
  });

  it("is case-insensitive, because a URL is not a trusted source of casing", () => {
    expect(clusterFromRpcUrl("https://API.DEVNET.SOLANA.COM")).toBe("devnet");
    expect(clusterFromRpcUrl("https://API.MAINNET-BETA.SOLANA.COM")).toBe("mainnet");
  });

  it("defaults to devnet for an unidentifiable endpoint, which is the pilot target", () => {
    expect(clusterFromRpcUrl("https://my-own-node.internal:8899")).toBe("devnet");
    expect(clusterFromRpcUrl(undefined)).toBe("devnet");
    expect(clusterFromRpcUrl("")).toBe("devnet");
  });
});
