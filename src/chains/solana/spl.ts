import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/** The System program. Required in an ATA create instruction; inert for the transfer itself. */
const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

/**
 * Minimal SPL (Solana Program Library) token support.
 *
 * ## Why this is hand-encoded rather than using @solana/spl-token
 *
 * `@solana/spl-token` is the canonical library and would be the obvious choice.
 * It was installed, measured, and removed: it depends on
 * `@solana/buffer-layout-utils` -> `bigint-buffer`, which carries
 * **GHSA-3gc7-fjrx-p6mg**, a high-severity buffer overflow in `toBigIntLE()`
 * (CVE affects every published version, so there is nothing to upgrade to), and
 * npm's suggested "fix" is a downgrade to `@solana/spl-token@0.1.8`. Taking a
 * 3-high unpatchable dependency into the tree of a backend that moves money, to
 * save ~100 lines of encoding, is not a trade worth making.
 *
 * `@solana/web3.js@1.99` exports no token helpers at all from its ESM entry
 * (verified), so the two instruction layouts below and the account read are
 * implemented directly against `PublicKey`/`TransactionInstruction`.
 *
 * ## Why that is safe
 *
 * These are not invented layouts. Both are fixed by the on-chain programs:
 *
 *  - `Transfer` is instruction index **9** of the SPL Token program, with a
 *    documented 81-byte body: amount, source, destination, owner.
 *  - `CreateAssociatedTokenAccount` is the associated-token program's single
 *    instruction: a 1-byte discriminant then funding, ata, owner, mint.
 *  - A token account is a 165-byte struct whose `amount` is a little-endian u64
 *    at offset 64.
 *
 * Crucially, the encoding is not taken on trust: `simulateSplTransfer` in
 * `src/chains/baseUnits.test.ts` and `scripts/verify-solana-spl.ts` submit a
 * built transaction to Solana Devnet's `simulateTransaction`. The SPL Token
 * program itself rejects the instruction if these bytes are wrong, so a wrong
 * discriminator, field order or offset fails loudly against a real validator
 * without needing a funded wallet.
 */

/** The canonical SPL Token program. Published constant, not a token address. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** Token-2022, which adds transfer fees and non-transferable accounts. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Derives and creates the canonical associated token accounts. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Instruction index of `Transfer` within the token program. */
const TOKEN_INSTRUCTION_TRANSFER = 9;
/** A token account is exactly this long; a mismatch means we read a non-account. */
const TOKEN_ACCOUNT_LENGTH = 165;
/** Byte offset of the little-endian u64 `amount` within a token account. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

/** Which token program owns a mint. SPL Token is the default; Token-2022 is opt-in per token. */
export type TokenProgram = "spl-token" | "token-2022";

export function tokenProgramId(program: TokenProgram): PublicKey {
  return program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Derives the associated token account (ATA) for `owner` and `mint`.
 *
 * This is a PDA of `[owner, tokenProgram, mint]` under the associated-token
 * program, which is why it is a derivation and not a lookup: the address is
 * fixed by the program, so it can be computed for any owner without a network
 * round trip, and it is the same address every other SPL wallet will derive.
 */
export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  program: TokenProgram = "spl-token",
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId(program).toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

/** Writes a little-endian u64 into `buf` at `offset`. */
function writeU64LE(buf: Buffer, offset: number, value: bigint): void {
  if (value < 0n) throw new RangeError(`SPL amount cannot be negative (got ${value})`);
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`SPL amount exceeds u64 (got ${value})`);
  }
  buf.writeBigUInt64LE(value, offset);
}

/**
 * `Transfer` on the SPL Token program: moves `amount` base units from the
 * owner's token account to the recipient's.
 *
 * `amount` MUST already be in the mint's base units — use `toBaseUnits` from
 * `src/utils/money.ts` with the mint's own `decimals`. A float here would lose
 * real value, and the program would happily execute a wrong amount.
 */
export function createTransferInstruction(args: {
  mint: PublicKey;
  /** The sender's token account, normally `associatedTokenAddress(mint, owner)`. */
  source: PublicKey;
  /** The recipient's token account, normally `associatedTokenAddress(mint, to)`. */
  destination: PublicKey;
  /** The account that signs and pays fees. May equal `source`'s owner. */
  owner: PublicKey;
  amount: bigint;
  program?: TokenProgram;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 * 4);
  data.writeUInt8(TOKEN_INSTRUCTION_TRANSFER, 0);
  writeU64LE(data, 1, args.amount);
  args.source.toBuffer().copy(data, 9);
  args.destination.toBuffer().copy(data, 41);
  args.owner.toBuffer().copy(data, 73);

  return new TransactionInstruction({
    programId: tokenProgramId(args.program ?? "spl-token"),
    // source and destination are writable, owner only signs.
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * `CreateAssociatedTokenAccount` for a recipient that has none.
 *
 * `idempotent: true` uses discriminant 1, which makes the instruction a no-op
 * when the account already exists. That matters here: without it, paying a
 * token to someone who has never held it would fail, and re-sending after a
 * partial failure would fail too.
 */
export function createAssociatedTokenAccountInstruction(args: {
  /** Pays the rent, and signs. */
  funder: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  program?: TokenProgram;
  /** Pass false to use the legacy non-idempotent form. */
  idempotent?: boolean;
}): TransactionInstruction {
  const idempotent = args.idempotent ?? true;
  const data = Buffer.alloc(1 + 32 * 4);
  data.writeUInt8(idempotent ? 1 : 0, 0);
  args.funder.toBuffer().copy(data, 1);
  associatedTokenAddress(args.mint, args.owner, args.program).toBuffer().copy(data, 33);
  args.owner.toBuffer().copy(data, 65);
  args.mint.toBuffer().copy(data, 97);

  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(args.mint, args.owner, args.program), isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Reads a token account's balance from raw account data.
 *
 * The layout is fixed: 32-byte mint, 32-byte owner, then a little-endian u64
 * amount at offset 64. The length is checked first, because a truncated buffer
 * read at a fixed offset silently yields a plausible wrong number — exactly the
 * failure mode that must not happen to a balance.
 */
export function readTokenAccountAmount(data: Buffer): bigint {
  if (data.length < TOKEN_ACCOUNT_LENGTH) {
    throw new Error(
      `Token account is ${data.length} bytes; expected ${TOKEN_ACCOUNT_LENGTH}. ` +
        "Refusing to read a balance from a buffer that is not a token account.",
    );
  }
  return data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

/**
 * True when `data` is the right length and shape to be a token account.
 *
 * Deliberately a plain boolean rather than a `data is Buffer` type predicate:
 * the callers already hold a `Buffer`, so a predicate would narrow the FALSE
 * branch to `never` and make the diagnostic in the error path un-typeable. The
 * guard is a length check, not a type refinement.
 */
export function isTokenAccountSize(data: Buffer | null): boolean {
  return data !== null && data.length === TOKEN_ACCOUNT_LENGTH;
}

/**
 * Rent-exempt minimum for a token account, in lamports.
 *
 * A transfer to a *new* associated account fails unless the sender can cover
 * this in SOL as well as the token, so the balance check has to include it.
 *
 * The value was initially a guess and the on-chain verification caught it:
 * `scripts/verify-solana-spl.ts` reads `getMinimumBalanceForRentExemption(165)`
 * from the cluster and fails if this constant disagrees. As of Solana Devnet at
 * slot ~506M it is 1_488_440 (the rent rate is cluster-parameterised and can
 * change, which is exactly why it is checked rather than trusted). Over-estimating
 * here would needlessly block a valid transfer, and under-estimating would let
 * one fail at the last moment.
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 1_488_440n;

/** SOL needed per signature, for the fee estimate of a token transfer. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Re-exported so callers do not need two imports for a SOL amount. */
export { LAMPORTS_PER_SOL };
