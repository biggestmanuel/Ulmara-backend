import { Connection, PublicKey, SystemProgram, Transaction, type AccountInfo } from "@solana/web3.js";
import { env } from "../../config/env.js";
import { fromBaseUnits, toBaseUnits } from "../../utils/money.js";
import { ProviderUnavailableError, type ChainAdapter, type TokenMetadata } from "../chain.types.js";
import {
  LAMPORTS_PER_SIGNATURE,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  associatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  isTokenAccountSize,
  readTokenAccountAmount,
} from "./spl.js";
import { listSplTokens, requireSplToken, resolveSplToken } from "./tokens.js";

const connection = env.SOLANA_RPC_URL ? new Connection(env.SOLANA_RPC_URL, "confirmed") : null;
const requireConnection = () => connection ?? (() => { throw new ProviderUnavailableError("SOL", "RPC"); })();

/** SOL's base unit is the lamport: 1 SOL = 1e9 lamports. */
const LAMPORT_DECIMALS = 9;

/** The chain's own symbol, which counts as the native asset. */
const NATIVE_SYMBOL = "SOL";

/** Reads a token account, tolerating an account that does not exist. */
async function tokenAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null> {
  return requireConnection().getAccountInfo(address);
}

/** True when the recipient already has a token account for this mint. */
async function hasTokenAccount(mint: PublicKey, owner: PublicKey): Promise<boolean> {
  const info = await tokenAccountInfo(associatedTokenAddress(mint, owner));
  return isTokenAccountSize(info?.data ?? null);
}

export const solanaAdapter: ChainAdapter = {
  chain: "SOL",

  isValidAddress(address: string): boolean {
    // Base58, 32-44 chars
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  },

  listTokens(): TokenMetadata[] {
    // Shape-compatible with the EVM adapter's listTokens so callers do not
    // branch on chain.
    return listSplTokens().map(({ symbol, name, decimals, address }) => ({ symbol, name, decimals, address }));
  },

  resolveToken(asset: string): TokenMetadata | null {
    const token = resolveSplToken(asset);
    if (!token) return null;
    return { symbol: token.symbol, name: token.name, decimals: token.decimals, address: token.address };
  },

  async getBalance(address, asset) {
    // `asset` may be the native coin or a token symbol (see ChainAdapter). SPL
    // tokens are read through getTokenBalance so there is one implementation of
    // "how many of token X does this address hold", not two.
    if (asset && asset !== NATIVE_SYMBOL) {
      return this.getTokenBalance!(address, asset);
    }
    // `Connection.getBalance` returns lamports as a JS `number` — that is the
    // SDK's contract, not a choice made here. We convert that number exactly
    // rather than dividing it by 1e9, so the only residual error is whatever
    // the double could not hold above 2^53 lamports (≈ 9.0e6 SOL). See the
    // note in src/utils/money.ts.
    return fromBaseUnits(BigInt(await requireConnection().getBalance(new PublicKey(address))), LAMPORT_DECIMALS);
  },

  /**
   * SPL token balance.
   *
   * An address that has never held the token has no token account at all, which
   * is a balance of zero rather than an error — treating it as an error would
   * make "new user, first transfer" fail.
   */
  async getTokenBalance(address, asset) {
    const token = requireSplToken(asset);
    const owner = new PublicKey(address);
    const info = await tokenAccountInfo(associatedTokenAddress(new PublicKey(token.address), owner, token.program));
    if (!info) return "0";
    // The length is read before the type guard so the error message can quote it;
    // narrowing to the guard's false branch would otherwise make the buffer
    // `never`, which is exactly the shape of a plausible-but-wrong balance read.
    const data = info.data;
    if (!isTokenAccountSize(data)) {
      throw new Error(
        `Account at the associated address for ${token.symbol} is not a token account ` +
          `(${data.length} bytes). Refusing to report a balance.`,
      );
    }
    // Exact: the raw u64 is a bigint, converted without a float in either
    // direction. An SPL token account holds up to u64 base units, well past
    // what a double can represent.
    return fromBaseUnits(readTokenAccountAmount(info.data), token.decimals);
  },

  async canPayGas(address, requiredNative) {
    // A SPL transfer to a NEW associated account also needs rent, not just the
    // signature fee, so the required amount is the larger of the two. Ignoring
    // this is how a transfer to a first-time recipient fails at the last moment.
    const needed = toBaseUnits(requiredNative, LAMPORT_DECIMALS);
    const rentPlusFee = TOKEN_ACCOUNT_RENT_LAMPORTS + LAMPORTS_PER_SIGNATURE;
    const required = needed > rentPlusFee ? needed : rentPlusFee;
    const balance = BigInt(await requireConnection().getBalance(new PublicKey(address)));
    return balance >= required;
  },

  async buildTransaction(input) {
    const { blockhash } = await requireConnection().getLatestBlockhash("confirmed");
    const from = new PublicKey(input.fromAddress);
    const feePayer = new PublicKey(input.fromAddress);

    // Native SOL: a System Program transfer. Exact — the amount arrives as a
    // validated decimal string and becomes lamports with integer maths only.
    if (input.asset === NATIVE_SYMBOL) {
      return new Transaction({ recentBlockhash: blockhash, feePayer }).add(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: new PublicKey(input.toAddress),
          lamports: toBaseUnits(input.amount, LAMPORT_DECIMALS),
        }),
      );
    }

    // SPL token: a token-program Transfer, plus an idempotent associated-account
    // creation when the recipient has never held this token.
    const token = requireSplToken(input.asset);
    const mint = new PublicKey(token.address);
    const to = new PublicKey(input.toAddress);
    const source = associatedTokenAddress(mint, from, token.program);
    const destination = associatedTokenAddress(mint, to, token.program);

    const transaction = new Transaction({ recentBlockhash: blockhash, feePayer });
    if (!(await hasTokenAccount(mint, to))) {
      transaction.add(createAssociatedTokenAccountInstruction({
        funder: from,
        owner: to,
        mint,
        program: token.program,
      }));
    }
    transaction.add(createTransferInstruction({
      mint,
      source,
      destination,
      owner: from,
      // The mint's OWN decimals, via the exact conversion. Using the native 9
      // here, or a float, would move the wrong amount — the single most
      // damaging SPL bug there is.
      amount: toBaseUnits(input.amount, token.decimals),
      program: token.program,
    }));
    return transaction;
  },

  async sendTransaction(signedTx) {
    if (typeof signedTx !== "string") throw new Error("Signed Solana transaction must be base64");
    return this.sendSignedTransaction!(signedTx);
  },

  async getTransactionStatus(txHash) {
    const result = await requireConnection().getSignatureStatuses([txHash]);
    const status = result.value[0];
    if (!status) return "pending";
    return status.err ? "failed" : status.confirmationStatus === "finalized" ? "confirmed" : "pending";
  },

  async estimateFee(input) {
    const transaction = await this.buildTransaction(input) as Transaction;
    const message = transaction.compileMessage();
    const fee = await requireConnection().getFeeForMessage(message);
    // Same SDK boundary as getBalance: `value` is lamports as a `number`.
    // `compileMessage` needs no recentBlockhash, so the real program-derived
    // fee is used rather than the per-signature constant.
    return fromBaseUnits(BigInt(fee.value ?? 0), LAMPORT_DECIMALS);
  },

  async sendSignedTransaction(signedTx: string) {
    const signature = await requireConnection().sendRawTransaction(Buffer.from(signedTx, "base64"), { preflightCommitment: "confirmed" });
    return { txHash: signature };
  },
};
