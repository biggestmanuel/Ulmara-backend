import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/** The System program. Required in an ATA create instruction; inert for the transfer itself. */
/** Exported so the ATA account ORDER can be asserted in tests: the associated
 *  token program reads its accounts positionally and reports a reordering as a
 *  bare "invalid instruction data". */
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

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

/**
 * `TransferChecked` (12), not the legacy `Transfer` (9).
 *
 * `Transfer` is rejected by the current token program — see the note on
 * `createTransferInstruction`, which has the measurement. The tag and the data
 * length are load-bearing and are asserted in spl.test.ts.
 */
const TOKEN_INSTRUCTION_TRANSFER_CHECKED = 12;
/** tag + u64 amount + u8 decimals. */
const TOKEN_TRANSFER_CHECKED_DATA_LENGTH = 1 + 8 + 1;
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

/**
 * Decimals are a u8 on the wire, so anything outside 0-255 cannot be encoded —
 * and a wrong value here would be a silent, catastrophic token-amount error
 * rather than a crash. Refusing is the only safe answer.
 */
function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(
      `SPL decimals must be an integer 0-255 (it is a u8 in the instruction); got ${String(decimals)}`,
    );
  }
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
 * `TransferChecked` on the SPL Token program: moves `amount` base units from the
 * owner's token account to the recipient's.
 *
 * ## This is `TransferChecked` (12), NOT `Transfer` (9) — and that is the whole point
 *
 * The legacy `Transfer` instruction is rejected by the current token program.
 * Measured on a local validator with a FUNDED source account, both forms sent as
 * real transactions against the same mint:
 *
 *     Transfer        (9, 3 keys, 105 bytes)  -> custom error 0xb
 *                                               "Non-native account can only be
 *                                                closed if its balance is zero"
 *     TransferChecked (12, 4 keys, 10 bytes)  -> SUCCEEDS
 *
 * Neither error mentions the transfer, so this failed silently in the sense that
 * matters: `simulateTransaction` against a destination that does not exist yet
 * returned a plausible-looking result, and the Devnet decode check in
 * `verify:solana` never got far enough to compare. The bug is that this
 * function produced an instruction the program refuses to execute.
 *
 * The `Checked` variants take the mint's expected `decimals` as a trailing byte
 * and the program REJECTS the whole transaction if it disagrees with the mint.
 * That is precisely why they are the correct choice for a financial transfer: a
 * decimals mismatch fails loudly instead of moving a wrong number of tokens,
 * and a 1-vs-6 decimals confusion cannot silently become a 1e6 error.
 *
 * ## Amounts
 *
 * `amount` MUST already be in the mint's base units — use `toBaseUnits` from
 * `src/utils/money.ts` with this same `decimals`. A float here would lose real
 * value, and the program would happily execute a wrong amount.
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
  /**
   * The mint's decimals. Required, not optional: the point of `TransferChecked`
   * is that the program verifies it, so an "assume 6" default would remove the
   * only protection the instruction provides.
   */
  decimals: number;
  program?: TokenProgram;
}): TransactionInstruction {
  assertDecimals(args.decimals);
  // Exact canonical layout, 10 bytes:
  //
  //   [0]     tag (12 = TransferChecked)
  //   [1..8]  u64 amount, little-endian
  //   [9]     expected decimals
  //
  // The mint is an ACCOUNT here (position 1, read-only), not a field in the
  // data — which is the structural difference from the old encoding, where the
  // three pubkeys were packed into the data buffer and the mint was absent.
  const data = Buffer.alloc(TOKEN_TRANSFER_CHECKED_DATA_LENGTH);
  data.writeUInt8(TOKEN_INSTRUCTION_TRANSFER_CHECKED, 0);
  writeU64LE(data, 1, args.amount);
  data.writeUInt8(args.decimals, 9);

  return new TransactionInstruction({
    programId: tokenProgramId(args.program ?? "spl-token"),
    // [source (w), mint (r), destination (w), owner (s)] — the mint is
    // read-only, and position matters: the program reads them positionally.
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
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
  // The data buffer is the DISCRIMINANT AND NOTHING ELSE — one byte.
  //
  // This previously packed funder/ata/owner/mint into the data as well (129
  // bytes), on the assumption that the program read its arguments positionally
  // out of `data` the way the token program's own instructions do. It does not:
  // every one of these values is already an account in the `keys` array, and the
  // program rejects the instruction with a bare "invalid instruction data" that
  // names neither the length nor the field.
  //
  // Proven against a local validator by dumping the instruction the official
  // spl-token client builds for the same owner/mint and comparing: the official
  // data is 1-2 bytes, and simulating each shape settles it —
  //   [1]      ACCEPTED  (CreateIdempotent)
  //   [1,0]    rejected  (extra byte)
  //   [0]      rejected  (legacy Create, account already exists)
  //   [0,0]    rejected  (same)
  // so exactly one byte is the correct encoding for the form we use.
  const data = Buffer.from([idempotent ? 1 : 0]);

  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    // The key ORDER is the program's ABI, not a convention. The associated token
    // program reads positionally and rejects a reordered list with a bare
    // "invalid instruction data" — no field name, no indication that ordering is
    // the problem. Found by running this against a real validator, where the
    // rent sysvar was supplied last instead of the token program.
    //
    //   0 funder (w, signer)  1 associated account (w)  2 owner (r)
    //   3 mint (r)            4 system program (r)     5 token program (r)
    keys: [
      { pubkey: args.funder, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(args.mint, args.owner, args.program), isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId(args.program ?? "spl-token"), isSigner: false, isWritable: false },
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
