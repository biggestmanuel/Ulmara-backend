/**
 * End-to-end SPL verification: create a mint, mint tokens, transfer them to a
 * first-time recipient, and read the balances back.
 *
 *   npm run verify:solana:e2e
 *
 * ## What this proves
 *
 * `npm run verify:solana` proves the instruction ENCODER is correct — a real
 * validator decodes our bytes via `simulateTransaction`. This goes the rest of
 * the way: it broadcasts real transactions and requires the money to actually
 * move, conserved exactly, at the base-unit level.
 *
 * ## Funding: a local validator, by default
 *
 * Earlier revisions of this file treated a funded wallet as an external blocker,
 * because every PUBLIC Devnet endpoint refuses `requestAirdrop` (api.devnet
 * .solana.com and devnet.rpcpool.com with 429, devnet.helius-rpc.com with 401,
 * devnet.genesysgo.net serving HTML). That was true but irrelevant: a local
 * `solana-test-validator` has its own faucet and airdrops unlimited SOL to
 * itself, with no account, no faucet website and no spend.
 *
 * So with no configuration at all this script starts a local validator on
 * 127.0.0.1:8899, funds a throwaway key, runs the whole flow, and tears the
 * validator down. It needs the Agave CLI (`solana-test-validator`) on PATH;
 * install it with the one-liner in the error message if it is missing.
 *
 * Point it at a real cluster instead by setting SOLANA_RPC_URL, in which case a
 * funded keypair is required — the script then uses `.solana-e2e-keypair.json`
 * or SOLANA_SIGNER_KEYPAIR, and asks for an airdrop if the balance is zero.
 *
 * ## Key handling
 *
 * With the local validator the keypair is generated in memory and never written
 * anywhere. With an external RPC it is saved to `.solana-e2e-keypair.json`
 * (gitignored, mode 0600) so the same address can be funded and reused. Either
 * way it is never logged and never committed.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { toBaseUnits, fromBaseUnits } from "../src/utils/money.js";
import {
  associatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  isTokenAccountSize,
  readTokenAccountAmount,
} from "../src/chains/solana/spl.js";

const KEYPAIR_PATH = ".solana-e2e-keypair.json";
const EXTERNAL_RPC = Boolean(process.env.SOLANA_RPC_URL);
const RPC = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
/**
 * The validator's ledger directory.
 *
 * Deliberately NOT `os.tmpdir()`: in WSL, /tmp is a tmpfs sized to RAM (1.8 GB
 * here), and a validator ledger reaches ~400 MB per run. Filling it produced
 * `ENOSPC: no space left on device`, which then failed an unrelated unit test
 * with a baffling "Failed Suites" and killed an in-flight run with ECONNRESET —
 * neither of which mentioned the disk at all. The home directory is on the real
 * filesystem, and the ledger is deleted on the way out.
 */
const LOCAL_LEDGER = join(homedir(), ".cache", "avora", "solana-e2e-ledger");

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
const IDX_INITIALIZE_MINT = 0;
/** `MintToChecked`. The legacy `MintTo` (3) is disabled by the token program. */
const IDX_MINT_TO_CHECKED = 14;
const MINT_DECIMALS = 6;
/** An SPL mint account is exactly 82 bytes. */
const MINT_ACCOUNT_LENGTH = 82;

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

// ---------------------------------------------------------------------------
step("0. a cluster to broadcast on");
// ---------------------------------------------------------------------------
// A local validator is the default because it removes the only thing that ever
// blocked this script. If one is already listening (left over from a previous
// run, or a developer's own), use it rather than fighting over the port.
let validator: ReturnType<typeof spawn> | null = null;
/** True only when THIS process started the validator, so cleanup is not skipped. */
let startedValidator = false;

const isUp = async (url: string): Promise<boolean> => {
  try {
    await new Connection(url, "confirmed").getSlot();
    return true;
  } catch {
    return false;
  }
};

if (await isUp(RPC)) {
  pass(`using the cluster already listening at ${RPC}`);
} else if (EXTERNAL_RPC) {
  fail(`${RPC} is not reachable and SOLANA_RPC_URL is set, so no local validator is started.
       Check the URL, or unset SOLANA_RPC_URL to use a local validator instead.`);
  process.exit(2);
} else {
  if (spawnSync("solana-test-validator", ["--version"], { encoding: "utf8" }).error) {
    console.log(`
  The Agave CLI is not on PATH, so there is no local validator to broadcast on.

  Install it — free, no account, no payment method:

      sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

  Then re-run. solana-test-validator has a built-in faucet that airdrops
  unlimited SOL to itself, which is why this no longer needs an external
  Devnet faucet, an account, or any spend.
`);
    process.exit(2);
  }
  note("no cluster listening; starting a local solana-test-validator (its own faucet)");
  spawnSync("mkdir", ["-p", LOCAL_LEDGER.slice(0, LOCAL_LEDGER.lastIndexOf("/"))]);
  spawnSync("rm", ["-rf", LOCAL_LEDGER]);
  startedValidator = true;
  validator = spawn(
    "solana-test-validator",
    ["--reset", "--ledger", LOCAL_LEDGER, "--rpc-port", "8899", "--quiet"],
    { stdio: "ignore" },
  );
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isUp(RPC)) {
      ready = true;
      pass(`local validator ready after ${i + 1}s`);
      break;
    }
  }
  if (!ready) {
    fail("the local validator never became reachable on 127.0.0.1:8899");
    validator.kill("SIGTERM");
    process.exit(2);
  }
}

/** Ends the run, always stopping the validator and removing its ledger. */
const finish = (code: number): never => {
  if (validator) {
    validator.kill("SIGTERM");
    note("local validator stopped");
  }
  if (startedValidator) {
    // Left behind, a ledger is ~400 MB. Several runs fill a WSL /tmp tmpfs and
    // the next thing that fails is something unrelated.
    spawnSync("rm", ["-rf", LOCAL_LEDGER]);
  }
  process.exit(code);
};

const conn = new Connection(RPC, "confirmed");
console.log(`  cluster version: ${(await conn.getVersion())["solana-core"]}`);
console.log(`  slot           : ${await conn.getSlot()}`);

// ---------------------------------------------------------------------------
step("1. a funded signer");
// ---------------------------------------------------------------------------
let payer: Keypair;
if (EXTERNAL_RPC) {
  // Only an external cluster needs a persisted key, so the same address can be
  // funded once and reused. Locally the key never leaves memory.
  const fromEnv = process.env.SOLANA_SIGNER_KEYPAIR;
  if (fromEnv && existsSync(fromEnv)) {
    payer = Keypair.fromJson(JSON.parse(readFileSync(fromEnv, "utf8")) as number[]);
    pass(`using SOLANA_SIGNER_KEYPAIR (${fromEnv})`);
  } else if (existsSync(KEYPAIR_PATH)) {
    payer = Keypair.fromJson(JSON.parse(readFileSync(KEYPAIR_PATH, "utf8")) as number[]);
    pass(`using the saved keypair at ${KEYPAIR_PATH}`);
  } else {
    payer = Keypair.generate();
    writeFileSync(KEYPAIR_PATH, JSON.stringify([...payer.secretKey]), { mode: 0o600 });
    chmodSync(KEYPAIR_PATH, 0o600);
    note(`generated a new keypair -> ${KEYPAIR_PATH} (gitignored, mode 0600)`);
  }
} else {
  payer = Keypair.generate();
  note("throwaway keypair generated in memory; never written to disk");
}

const recipient = Keypair.generate();
console.log(`  payer     : ${payer.publicKey.toBase58()}`);
console.log(`  recipient : ${recipient.publicKey.toBase58()}`);

let balance = BigInt(await conn.getBalance(payer.publicKey));
if (balance === 0n) {
  try {
    await conn.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
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
  console.log("  Only reachable against an external cluster. Send 1-2 SOL to that");
  console.log("  address from a faucet and re-run; everything below is ready.");
  finish(2);
}
pass(`signer funded with ${fromBaseUnits(balance, 9)} SOL`);

// ---------------------------------------------------------------------------
step("2. create an SPL mint we hold the authority for");
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

/**
 * `MintToChecked` — instruction 14, NOT the legacy `MintTo` (3).
 *
 * The legacy instruction is disabled in the current token program: it carries no
 * decimals, so it cannot verify the amount against the mint, and the program now
 * rejects it with "InvalidAccountData" — an error that names neither the
 * instruction nor the field. Confirmed by dumping the instruction the official
 * spl-token client builds for the same mint:
 *
 *     official : tag=14 len=10 hex=0e00ca9a3b0000000006   (amount 1e9, decimals 6)
 *     legacy 3 : rejected by the program
 *
 * `Checked` variants take the expected decimals as a trailing byte and the
 * program refuses the transaction if it disagrees with the mint — which is the
 * whole reason to prefer them. Same for `TransferChecked` (12) over `Transfer`
 * (9), though plain `Transfer` still works.
 */
function mintToChecked(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(1 + 8 + 1);
  data.writeUInt8(IDX_MINT_TO_CHECKED, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(MINT_DECIMALS, 9);
  // [mint (w), destination (w), mint_authority (s)] — the mint is writable but
  // NOT a signer; only the authority signs.
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * `extraSigners` exists because creating an account requires the NEW account's
 * keypair to sign, not just the fee payer. Both programs log "success" and the
 * transaction still fails, because a missing signature is caught after
 * execution — so the logs are actively misleading here.
 */
async function sendAndConfirm(
  ixs: TransactionInstruction[],
  label: string,
  extraSigners: Keypair[] = [],
): Promise<boolean> {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: (await conn.getLatestBlockhash("confirmed")).blockhash,
  });
  for (const ix of ixs) tx.add(ix);
  tx.sign(payer, ...extraSigners);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const bh = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    pass(`${label} (${sig.slice(0, 20)}…)`);
    return true;
  } catch (err) {
    // "Simulation failed." on its own is useless — web3.js hides the actual
    // reason behind it, and the reason is the whole point of the run. Pull the
    // detailed logs out of the thrown error, and if they are missing, simulate
    // the same transaction separately, which returns the logs as structured
    // data rather than burying them in a message.
    const raw = err as { message?: string; logs?: string[] };
    // Keep the TAIL. A transaction with three programs produces a long log and
    // the reason is at the end; slicing the head truncated exactly the lines
    // that mattered. Noise lines are dropped so the tail is readable.
    const interesting = (raw.logs ?? []).filter(
      (l) => !/consumed \d+ of \d+ compute units|invoke \[\d+\] success|^Program return:/.test(l),
    );
    const detail = interesting.join(" | ");
    if (detail) {
      fail(`${label} FAILED: …${detail.slice(-600)}`);
    } else {
      const sim = await conn.simulateTransaction(tx).catch((e: Error) => {
        fail(`${label} FAILED (and simulate also threw: ${e.message.split("\n")[0].slice(0, 120)})`);
        return null;
      });
      const logs = sim?.value?.logs?.join(" | ") ?? "";
      fail(logs ? `${label} FAILED: ${logs.slice(0, 400)}` : `${label} FAILED: ${raw.message ?? "unknown error"}`);
    }
    return false;
  }
}

const mint = Keypair.generate();
const payerAta = associatedTokenAddress(mint.publicKey, payer.publicKey);
const recipientAta = associatedTokenAddress(mint.publicKey, recipient.publicKey);

// TWO transactions, not one. The mint account must be created and initialized
// before the associated-token program is asked to derive an address for it.
// Doing all three in one transaction makes the ATA program fail with an empty
// "Program log:" and no error code, which is not a diagnosable failure — the
// separation is also what production does.
const rent = await conn.getMinimumBalanceForRentExemption(MINT_ACCOUNT_LENGTH);
if (!(await sendAndConfirm([
  // The mint ACCOUNT must exist before it can be initialized: the token program
  // cannot create its own accounts. Omitting this makes InitializeMint fail with
  // InvalidAccountData, which reads like an encoding bug but is a missing step.
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: rent,
    space: MINT_ACCOUNT_LENGTH,
    programId: TOKEN_PROGRAM,
  }),
  initializeMint(mint.publicKey, payer.publicKey, MINT_DECIMALS),
], "create the mint account and initialize it (6 decimals)", [mint]))) {
  finish(1);
}

if (!(await sendAndConfirm([
  createAssociatedTokenAccountInstruction({ funder: payer.publicKey, owner: payer.publicKey, mint: mint.publicKey }),
], "open the sender's associated token account"))) {
  finish(1);
}

const mintInfo = await conn.getAccountInfo(mint.publicKey);
if (mintInfo && mintInfo.data[44] === MINT_DECIMALS) {
  pass(`the chain reports ${mintInfo.data[44]} decimals, as we encoded`);
} else {
  fail(`the chain reports ${mintInfo?.data[44]} decimals, expected ${MINT_DECIMALS}`);
}

const minted = toBaseUnits("1000", MINT_DECIMALS);
await sendAndConfirm([mintToChecked(mint.publicKey, payerAta, payer.publicKey, minted)], `mint ${fromBaseUnits(minted, MINT_DECIMALS)}`);

// ---------------------------------------------------------------------------
step("3. transfer to a first-time recipient (must also create their account)");
// ---------------------------------------------------------------------------
const beforeRecipientSol = BigInt(await conn.getBalance(recipient.publicKey));
const firstText = "123.456789";
const first = toBaseUnits(firstText, MINT_DECIMALS);

if (await sendAndConfirm([
  createAssociatedTokenAccountInstruction({ funder: payer.publicKey, owner: recipient.publicKey, mint: mint.publicKey }),
  createTransferInstruction({ mint: mint.publicKey, source: payerAta, destination: recipientAta, owner: payer.publicKey, amount: first, decimals: MINT_DECIMALS }),
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
  step("4. second transfer, same recipient (no redundant account creation)");
  // -------------------------------------------------------------------------
  const secondText = "0.000001"; // the smallest representable unit
  const second = toBaseUnits(secondText, MINT_DECIMALS);
  if (await sendAndConfirm([
    createTransferInstruction({ mint: mint.publicKey, source: payerAta, destination: recipientAta, owner: payer.publicKey, amount: second, decimals: MINT_DECIMALS }),
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
  step("5. an over-balance transfer must be rejected, not silently clamped");
  // -------------------------------------------------------------------------
  const absurd = toBaseUnits("99999999", MINT_DECIMALS);
  const overTx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: (await conn.getLatestBlockhash("confirmed")).blockhash,
  }).add(createTransferInstruction({
    mint: mint.publicKey, source: payerAta, destination: recipientAta, owner: payer.publicKey, amount: absurd,
    decimals: MINT_DECIMALS,
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
finish(failures === 0 ? 0 : 1);
