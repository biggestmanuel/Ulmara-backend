import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { env } from "../../config/env.js";
import { ProviderUnavailableError, type ChainAdapter } from "../chain.types.js";

const connection = env.SOLANA_RPC_URL ? new Connection(env.SOLANA_RPC_URL, "confirmed") : null;
const requireConnection = () => connection ?? (() => { throw new ProviderUnavailableError("SOL", "RPC"); })();

export const solanaAdapter: ChainAdapter = {
  chain: "SOL",

  isValidAddress(address: string): boolean {
    // Base58, 32-44 chars
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  },

  async getBalance(address, asset) {
    if (asset) throw new Error("SPL token balance reads are not implemented yet");
    return String((await requireConnection().getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL);
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
      lamports: Math.round(Number(input.amount) * LAMPORTS_PER_SOL),
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
    return String((fee.value ?? 0) / LAMPORTS_PER_SOL);
  },

  async sendSignedTransaction(signedTx: string) {
    const signature = await requireConnection().sendRawTransaction(Buffer.from(signedTx, "base64"), { preflightCommitment: "confirmed" });
    return { txHash: signature };
  },
};
