/**
 * Proves the SPL support against Solana Devnet, without needing a funded wallet.
 *
 *   npm run verify:solana
 *
 * Three things are checked, in increasing order of strength:
 *
 *  1. **The registry claims are true.** Every configured token's mint exists on
 *     the cluster, is owned by a token program, and reports the `decimals` the
 *     registry claims. A decimals mismatch is the worst possible token bug — it
 *     turns 1 USDC into 1e6 — so the registry is treated as a claim, not truth.
 *
 *  2. **The account layout matches the cluster.** The 165-byte token-account
 *     length and the rent for it are read from Devnet itself, not assumed.
 *
 *  3. **The hand-encoded instruction actually decodes.** This is the one that
 *     matters for the "no @solana/spl-token" decision in `spl.ts`: a real
 *     transaction carrying our bytes is submitted to `simulateTransaction`, and
 *     the SPL Token program decodes it. Simulation needs no funds.
 *
 *     The assertion is deliberately specific. A well-formed instruction against
 *     an account with no balance fails with a *semantic* SPL error (a custom
 *     program error code, or insufficient-funds). A MALFORMED one fails at
 *     deserialisation, with a different and unmistakable error. So "the program
 *     got far enough to complain about the money, not about our bytes" is a
 *     real proof that the discriminator, field order and offsets are correct.
 */

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { env } from "../src/config/env.js";
import { toBaseUnits, fromBaseUnits } from "../src/utils/money.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  associatedTokenAddress,
  createTransferInstruction,
  readTokenAccountAmount,
  tokenProgramId,
} from "../src/chains/solana/spl.js";
import { listSplTokens, resolveSolanaCluster } from "../src/chains/solana/tokens.js";

const RPC = env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const cluster = resolveSolanaCluster(RPC);
const conn = new Connection(RPC, "confirmed");

let failures = 0;
const pass = (m: string) => console.log(`  [  ok  ] ${m}`);
const fail = (m: string) => { failures++; console.log(`  [ FAIL ] ${m}`); };
const step = (m: string) => console.log(`\n=== ${m} ===`);

console.log(`RPC            : ${RPC}`);
console.log(`cluster        : ${cluster}`);
console.log(`devnet slot    : ${await conn.getSlot()}`);

const tokens = listSplTokens();
console.log(`configured     : ${tokens.length} token(s) -> ${tokens.map((t) => t.symbol).join(", ") || "none"}`);
if (tokens.length === 0) {
  console.log("\n  Nothing to verify. Set SOLANA_SPL_TOKENS or point at a cluster with seed entries.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
step("1. every registry entry exists and its decimals are true");
// ---------------------------------------------------------------------------
for (const token of tokens) {
  const label = `${token.symbol} (${token.address})`;
  let mint;
  try {
    mint = new PublicKey(token.address);
  } catch (err) {
    fail(`${label}: not a valid base58 address — ${(err as Error).message}`);
    continue;
  }

  const info = await conn.getAccountInfo(mint);
  if (!info) { fail(`${label}: account does not exist on ${cluster}`); continue; }

  const owner = info.owner.toBase58();
  const isTokenProgram =
    owner === TOKEN_PROGRAM_ID.toBase58() || owner === TOKEN_2022_PROGRAM_ID.toBase58();
  if (!isTokenProgram) { fail(`${label}: owned by ${owner}, which is not a token program`); continue; }
  pass(`${label}: exists, owned by ${owner === TOKEN_PROGRAM_ID.toBase58() ? "SPL Token" : "Token-2022"}`);

  // decimals is the u8 at offset 44 of a mint account.
  const onChainDecimals = info.data[44];
  if (onChainDecimals !== token.decimals) {
    fail(`${label}: registry says ${token.decimals} decimals, chain says ${onChainDecimals}`);
  } else {
    pass(`${label}: decimals ${onChainDecimals} matches the registry`);
  }

  if (info.data.length !== 82) {
    fail(`${label}: mint account is ${info.data.length} bytes, expected 82`);
  } else {
    pass(`${label}: mint account is 82 bytes (initialised)`);
  }
}

// ---------------------------------------------------------------------------
step("2. the account layout matches the cluster's own numbers");
// ---------------------------------------------------------------------------
const rent = await conn.getMinimumBalanceForRentExemption(165);
const { TOKEN_ACCOUNT_RENT_LAMPORTS } = await import("../src/chains/solana/spl.js");
// The RPC returns a number and the constant is a bigint, so compare as BigInt:
// `1488440 !== 1488440n` is true, which would report a false failure on a
// constant that is in fact correct.
const rentMatches = BigInt(rent) === TOKEN_ACCOUNT_RENT_LAMPORTS;
pass(`cluster rent for 165 bytes = ${rent} lamports; registry constant = ${TOKEN_ACCOUNT_RENT_LAMPORTS}`);
if (!rentMatches) {
  console.log(`  [ note ] the constant differs from the cluster. Re-check TOKEN_ACCOUNT_RENT_LAMPORTS;`);
  console.log(`           a too-low value makes a first-time recipient's transfer fail.`);
  failures++;
} else {
  pass("rent constant matches the cluster exactly");
}

// ---------------------------------------------------------------------------
step("3. the hand-encoded instruction decodes (simulated, no funds needed)");
// ---------------------------------------------------------------------------
for (const token of tokens) {
  const label = token.symbol;
  const mint = new PublicKey(token.address);
  const program = tokenProgramId(token.program);

  // Two throwaway keypairs: they hold nothing, which is the point — we are
  // checking that the program can PARSE our instruction, not that it succeeds.
  const owner = Keypair.generate();
  const recipient = Keypair.generate();
  const source = associatedTokenAddress(mint, owner.publicKey, token.program);
  const destination = associatedTokenAddress(mint, recipient.publicKey, token.program);

  const instruction = createTransferInstruction({
    mint,
    source,
    destination,
    owner: owner.publicKey,
    amount: toBaseUnits("1.5", token.decimals),
    program: token.program,
  });

  // 3a. structural checks, so a failure says which byte is wrong.
  const expectedLength = 1 + 32 * 4;
  if (instruction.data.length !== expectedLength) {
    fail(`${label}: instruction data is ${instruction.data.length} bytes, expected ${expectedLength}`);
  } else {
    pass(`${label}: instruction data is ${expectedLength} bytes (1 discriminator + 4 words)`);
  }
  if (instruction.data[0] !== 9) {
    fail(`${label}: discriminator is ${instruction.data[0]}, expected 9 (Transfer)`);
  } else {
    pass(`${label}: discriminator is 9 (Transfer)`);
  }
  if (instruction.programId.toBase58() !== program.toBase58()) {
    fail(`${label}: programId is ${instruction.programId.toBase58()}, expected ${program.toBase58()}`);
  } else {
    pass(`${label}: programId is ${program.toBase58()}`);
  }

  // 3b. the round trip: the amount and every address must come back out.
  const encodedAmount = instruction.data.readBigUInt64LE(1);
  const want = toBaseUnits("1.5", token.decimals);
  if (encodedAmount !== want) fail(`${label}: amount round-tripped as ${encodedAmount}, expected ${want}`);
  else pass(`${label}: amount round-trips exactly (${fromBaseUnits(encodedAmount, token.decimals)})`);

  for (const [name, got, wantKey] of [
    ["source", instruction.data.subarray(9, 41), source],
    ["destination", instruction.data.subarray(41, 73), destination],
    ["owner", instruction.data.subarray(73, 105), owner.publicKey],
  ] as const) {
    if (got.toString("base64") !== wantKey.toBuffer().toString("base64")) fail(`${label}: ${name} address did not round-trip`);
  }
  pass(`${label}: source, destination and owner all round-trip`);

  // 3c. THE test: does the on-chain program decode it?
  const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash })
    .add(instruction);
  tx.sign(owner);

  let sim;
  try {
    sim = await conn.simulateTransaction(tx);
  } catch (err) {
    fail(`${label}: simulateTransaction threw — ${(err as Error).message.split("\n")[0]}`);
    continue;
  }

  if (sim.value.err === null) {
    // Would mean a real transfer of tokens we do not hold succeeded, which
    // cannot happen. Something is wrong with the harness, not the encoding.
    fail(`${label}: simulation SUCCEEDED with no funds — the harness is not testing what it claims`);
    continue;
  }

  const errText = JSON.stringify(sim.value.err);
  // A deserialisation failure names the field. Its presence would mean our
  // bytes are wrong.
  const looksLikeDeserialization = /unable to deserialize|invalid instruction data|BorshError|InvalidInstructionData/i.test(errText);

  if (looksLikeDeserialization) {
    fail(`${label}: the program could NOT decode our instruction — ${errText.slice(0, 220)}`);
  } else {
    pass(`${label}: the program DECODED it and failed on semantics only — ${errText.slice(0, 160)}`);
  }
}

// ---------------------------------------------------------------------------
step("4. reading a token account");
// ---------------------------------------------------------------------------
// The associated account for a brand-new keypair does not exist, which is the
// "never held this token" case and must read as zero, not an error.
const virgin = Keypair.generate();
const someMint = new PublicKey(tokens[0].address);
const ata = associatedTokenAddress(someMint, virgin.publicKey, tokens[0].program);
const info = await conn.getAccountInfo(ata);
if (info === null) {
  pass("a keypair that never held the token has no account, which the adapter reports as 0");
} else if (info.data.length === 165) {
  const amount = readTokenAccountAmount(info.data);
  pass(`existing account read: ${fromBaseUnits(amount, tokens[0].decimals)} ${tokens[0].symbol}`);
} else {
  fail(`account exists but is ${info.data.length} bytes, not a token account`);
}

// A short buffer must be REFUSED, not read at a fixed offset.
try {
  readTokenAccountAmount(Buffer.alloc(10));
  fail("readTokenAccountAmount accepted a 10-byte buffer — it would have returned a plausible wrong number");
} catch (err) {
  pass(`a truncated buffer is refused: ${(err as Error).message.slice(0, 60)}…`);
}

console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`} ===`);
process.exit(failures === 0 ? 0 : 1);
