/**
 * End-to-end SPL verification on Devnet: create a mint, mint tokens, transfer
 * them to a first-time recipient, and read the balances back.
 *
 *   npm run verify:solana:e2e
 *
 * ## What this proves, and what it cannot
 *
 * `npm run verify:solana` proves the instruction ENCODER is correct — a real
 * Devnet validator decodes our bytes via `simulateTransaction`, which needs no
 * funds. That is as far as verification can go without SOL.
 *
 * This script goes the rest of the way: it broadcasts a real transfer and
 * checks the money actually moved. That requires a funded Devnet wallet, and
 * **no public RPC will give you one** — as of this writing every public Devnet
 * endpoint tried (api.devnet.solana.com, api.testnet.solana.com,
 * devnet.helius-rpc.com, devnet.genesysgo.net, devnet.rpcpool.com,
 * solana-devnet.g.alchemy.com) refuses `requestAirdrop` with 429, 401 or an
 * HTML error page. Funding a wallet is a genuine external step.
 *
 * ## Getting a funded wallet
 *
 * Run it once with no key present. It generates a keypair, saves it to
 * `.solana-e2e-keypair.json` (gitignored, mode 0600), and prints the address:
 *
 *     SOLANA_DEVNET_ADDRESS: <base58>
 *
 * Send 1-2 SOL to that address from any Devnet faucet, then re-run this script.
 * It picks the saved key up automatically.
 *
 * ## Key handling
 *
 * The keypair never leaves the working tree, is never logged, and is never
 * committed. `.gitignore` carries an explicit entry, and the file is created
 * 0600. This is a throwaway Devnet key with no access to anything of value —
 * but it is still a real key, so it is treated as one.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { toBaseUnits, fromBaseUnits } from "../src/utils/money.js";
import {
  associatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  isTokenAccountSize,
  readTokenAccountAmount,
} from "../src/chains/solana/spl.js";

const KEYPAIR_PATH = ".solana-e2e-keypair.json";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
const IDX_INITIALIZE_MINT = 0;
const IDX_MINT_TO = 3;
const MINT_DECIMALS = 6;

let failures = 0;
const pass = (m: string) => console.log(`  [  ok  ] ${m}`);
const fail = (m: string) => { failures++; console.log(`  [  FAIL ] ${m}`); };
const note = (m: string) => console.log(`  [ note ] ${m}`);
const step = (m: string) => console.log(`\n=== ${m} ===`);

/** Reports a boolean assertion. Used instead of `cond ? pass() : fail()`, which
 *  is an expression statement and trips no-unused-expressions. */
const check = (cond: boolean, onPass: string, onFail: string): void => {
  if (cond) pass(onPass);
  else fail(onFail);
};

console.log(`RPC  : ${RPC}`);
console.log(`slot : ${await conn.getSlot()}`);

// ---------------------------------------------------------------------------
step("0. a funded signer");
// ---------------------------------------------------------------------------
let payer: Keypair;
if (existsSync(KEYPAIR_PATH)) {
  payer = Keypair.fromJson(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[]);
  pass(`using the saved keypair at ${KEYPAIR_PATH}`);
} else {
  payer = Keypair.generate();
  writeFileSync(KEYPAIR_PATH, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
  chmodSync(KEYPAIR_PATH, 0o600);
  note(`generated a new keypair -> ${KEYPAIR_PATH} (gitignored, mode 0600)`);
}

const recipient = Keypair.generate();
console.log(`  payer     : ${payer.publicKey.toBase58()}`);
console.log(`  recipient : ${recipient.publicKey.toBase58()}`);

let balance = BigInt(await conn.getBalance(payer.publicKey));
if (balance === 0n) {
  // One attempt, so a fresh environment gets a chance without a retry loop.
  try {
    await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    note("airdrop requested; waiting for it to land");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      balance = BigInt(await conn.getBalance(payer.publicKey));
      if (balance > 0n) break;
    }
  } catch (err) {
    note(`airdrop refused: ${(err as Error).message.split("\n")[0].slice(0, 70)}`);
  }
}

if (balance === 0n) {
  console.log(`\n  SOLANA_DEVNET_ADDRESS: ${payer.publicKey.toBase58()}`);
  console.log("\n=== RESULT: NEEDS A FUNDED WALLET ===");
  console.log("  Send 1-2 SOL to that address from any Devnet faucet, then re-run");
  console.log("  `npm run verify:solana:e2e`. Everything below is ready to go.");
  process.exit(2);
}
pass(`signer funded with ${fromBaseUnits(balance, 9)} SOL`);

// ---------------------------------------------------------------------------
step("1. create an SPL mint we hold the authority for");
// ---------------------------------------------------------------------------
/** Instruction 0: decimals + mintAuthority + freezeAuthority. */
function initializeMint(mint: PublicKey, authority: PublicKey, decimals: number): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 32);
  data.writeUInt8(IDX_INITIALIZE_MINT, 0);
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  Buffer.alloc(32).copy(data, 34); // no freeze authority
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Instruction 3: u64 amount. */
function mintTo(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(IDX_MINT_TO, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

async function sendAndConfirm(ixs: TransactionInstruction[], label: string): Promise<boolean> {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: (await conn.getLatestBlockhash("confirmed")).blockhash,
  });
  for (const ix of ixs) tx.add(ix);
  tx.sign(payer);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const bh = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    pass(`${label} (${sig.slice(0, 20)}…)`);
    return true;
  } catch (err) {
    fail(`${label} FAILED: ${(err as Error).message.split("\n")[0].slice(0, 90)}`);
    return false;
  }
}

const mint = Keypair.generate();
const payerAta = associatedTokenAddress(mint.publicKey, payer.publicKey);
const recipientAta = associatedTokenAddress(mint.publicKey, recipient.publicKey);

if (!(await sendAndConfirm([
  initializeMint(mint.publicKey, payer.publicKey, MINT_DECIMALS),
  createAssociatedTokenAccountInstruction({ funder: payer.publicKey, owner: payer.publicKey, mint: mint.publicKey }),
], "create mint + sender token account"))) {
  process.exit(1);
}

const mintInfo = await conn.getAccountInfo(mint.publicKey);
if (mintInfo && mintInfo.data[44] === MINT_DECIMALS) {
  pass(`the chain reports ${mintInfo.data[44]} decimals, as we encoded`);
} else {
  fail(`the chain reports ${mintInfo?.data[44]} decimals, expected ${MINT_DECIMALS}`);
}

const minted = toBaseUnits("1000", MINT_DECIMALS);
await sendAndConfirm([mintTo(mint.publicKey, payerAta, payer.publicKey, minted)], `mint ${fromBaseUnits(minted, MINT_DECIMALS)}`);

// ---------------------------------------------------------------------------
step("2. transfer to a first-time recipient (must also create their account)");
// ---------------------------------------------------------------------------
const beforeRecipientSol = BigInt(await conn.getBalance(recipient.publicKey));
const firstText = "123.456789";
const first = toBaseUnits(firstText, MINT_DECIMALS);

if (await sendAndConfirm([
  createAssociatedTokenAccountInstruction({ funder: payer.publicKey, owner: recipient.publicKey, mint: mint.publicKey }),
  createTransferInstruction({ mint: mint.publicKey, source: payerAta, destination: recipientAta, owner: payer.publicKey, amount: first }),
], `transfer ${firstText} to a recipient who has never held this token`)) {

  const toInfo = await conn.getAccountInfo(recipientAta);
  if (toInfo && isTokenAccountSize(toInfo.data)) {
    const got = readTokenAccountAmount(toInfo.data);
    check(got === first,
      `recipient holds exactly ${fromBaseUnits(got, MINT_DECIMALS)}`,
      `recipient holds ${fromBaseUnits(got, MINT_DECIMALS)}, expected ${firstText}`);
  } else {
    fail("the recipient's token account was not created");
  }

  const fromInfo = await conn.getAccountInfo(payerAta);
  if (fromInfo && isTokenAccountSize(fromInfo.data)) {
    const left = readTokenAccountAmount(fromInfo.data);
    const expected = minted - first;
    check(left === expected,
      `sender holds exactly ${fromBaseUnits(left, MINT_DECIMALS)} — conservation holds`,
      `sender holds ${fromBaseUnits(left, MINT_DECIMALS)}, expected ${fromBaseUnits(expected, MINT_DECIMALS)}`);
  }

  const afterRecipientSol = BigInt(await conn.getBalance(recipient.publicKey));
  if (afterRecipientSol > beforeRecipientSol) {
    pass(`sender SOL-funded the recipient's rent: ${fromBaseUnits(afterRecipientSol - beforeRecipientSol, 9)} SOL`);
  }

  // -------------------------------------------------------------------------
  step("3. second transfer, same recipient (no redundant account creation)");
  // -------------------------------------------------------------------------
  const secondText = "0.000001"; // the smallest representable unit
  const second = toBaseUnits(secondText, MINT_DECIMALS);
  if (await sendAndConfirm([
    createTransferInstruction({ mint: mint.publicKey, source: payerAta, destination: recipientAta, owner: payer.publicKey, amount: second }),
  ], `transfer ${secondText} in a single instruction`)) {
    const toInfo = await conn.getAccountInfo(recipientAta);
    if (toInfo && isTokenAccountSize(toInfo.data)) {
      const got = readTokenAccountAmount(toInfo.data);
      const expected = first + second;
      check(got === expected,
        `recipient now holds ${fromBaseUnits(got, MINT_DECIMALS)} — the smallest unit round-tripped exactly`,
        `recipient holds ${fromBaseUnits(got, MINT_DECIMALS)}, expected ${fromBaseUnits(expected, MINT_DECIMALS)}`);
    }
  }

  // -------------------------------------------------------------------------
  step("4. an over-balance transfer must be rejected, not silently clamped");
  // -------------------------------------------------------------------------
  const absurd = toBaseUnits("99999999", MINT_DECIMALS);
  const overTx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: (await conn.getLatestBlockhash("confirmed")).blockhash,
  }).add(createTransferInstruction({
    mint: mint.publicKey, source: payerAta, destination: recipientAta, owner: payer.publicKey, amount: absurd,
  }));
  overTx.sign(payer);
  try {
    const sim = await conn.simulateTransaction(overTx);
    check(sim.value.err !== null,
      `an over-balance transfer is rejected (${JSON.stringify(sim.value.err).slice(0, 60)})`,
      "a transfer far exceeding the balance was ACCEPTED — the cluster is not enforcing balances");
  } catch (err) {
    pass(`an over-balance transfer is rejected (${(err as Error).message.split("\n")[0].slice(0, 60)})`);
  }
}

console.log(`\nmint for this run: ${mint.publicKey.toBase58()}`);
console.log(`\n=== RESULT: ${failures === 0 ? "ALL CHECKS PASSED — SPL TRANSFER VERIFIED ON-CHAIN" : `${failures} FAILURE(S)`} ===`);
process.exit(failures === 0 ? 0 : 1);
