import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { env } from "../../config/env.js";
import { fromBaseUnits, toBaseUnits } from "../../utils/money.js";
import { ProviderUnavailableError, type ChainAdapter } from "../chain.types.js";

const connection = env.SOLANA_RPC_URL ? new Connection(env.SOLANA_RPC_URL, "confirmed") : null;
const requireConnection = () => connection ?? (() => { throw new ProviderUnavailableError("SOL", "RPC"); })();

/** SOL's base unit is the lamport: 1 SOL = 1e9 lamports. */
const LAMPORT_DECIMALS = 9;

export const solanaAdapter: ChainAdapter = {
  chain: "SOL",

  isValidAddress(address: string): boolean {
    // Base58, 32-44 chars
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  },

  async getBalance(address, asset) {
    // `asset` may be the native coin or a token symbol (see ChainAdapter).
    // Only the native path is implemented, so the chain's own symbol is
    // accepted and anything else is a genuine "not implemented" rather than
    // a confusing error on a perfectly valid native lookup.
    if (asset && asset !== "SOL") throw new Error("SPL token balance reads are not implemented yet");
    // `Connection.getBalance` returns lamports as a JS `number` — that is the
    // SDK's contract, not a choice made here. We convert that number exactly
    // rather than dividing it by 1e9, so the only residual error is whatever
    // the double could not hold above 2^53 lamports (≈ 9.0e6 SOL). See the
    // note in src/utils/money.ts.
    return fromBaseUnits(BigInt(await requireConnection().getBalance(new PublicKey(address))), LAMPORT_DECIMALS);
  },

  async buildTransaction(input) {
    if (input.asset !== "SOL") throw new Error("Solana adapter supports native SOL only");
    const { blockhash } = await requireConnection().getLatestBlockhash("confirmed");
    return new Transaction({
      recentBlockhash: blockhash,
      feePayer: new PublicKey(input.fromAddress),
    }).add(SystemProgram.transfer({
      fromPubkey: new PublicKey(input.fromAddress),
      toPubkey: new PublicKey(input.toAddress),
      // Exact: the amount arrives as a validated decimal string and becomes
      // lamports with integer maths only. This is the direction that decides
      // how much money moves, so it must never touch a float.
      lamports: toBaseUnits(input.amount, LAMPORT_DECIMALS),
    }));
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
    return fromBaseUnits(BigInt(fee.value ?? 0), LAMPORT_DECIMALS);
  },

  async sendSignedTransaction(signedTx: string) {
    const signature = await requireConnection().sendRawTransaction(Buffer.from(signedTx, "base64"), { preflightCommitment: "confirmed" });
    return { txHash: signature };
  },
};
