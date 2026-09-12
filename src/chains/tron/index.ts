import { TronWeb } from "tronweb";
import { env } from "../../config/env.js";
import type { ChainAdapter } from "../chain.types.js";

const tron = new TronWeb({ fullHost: env.TRON_RPC_URL ?? "https://api.shasta.trongrid.io" });

export const tronAdapter: ChainAdapter = {
  chain: "TRON",

  isValidAddress(address: string): boolean {
    // Tron addresses start with T, base58, 34 chars
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  },

  async getBalance(address, asset) {
    if (asset) throw new Error("TRC-20 balance reads are not implemented yet");
    return String((await tron.trx.getBalance(address)) / 1_000_000);
  },

  async buildTransaction(input) {
    if (input.asset !== "TRX") throw new Error("TRON adapter supports native TRX only");
    return tron.transactionBuilder.sendTrx(input.toAddress, Math.round(Number(input.amount) * 1_000_000), input.fromAddress);
  },

  async sendTransaction(signedTx) {
    if (typeof signedTx !== "string") throw new Error("Signed TRON transaction must be serialized JSON");
    return this.sendSignedTransaction!(signedTx);
  },

  async getTransactionStatus(txHash) {
    const info = await tron.trx.getTransactionInfo(txHash);
    if (!info?.id) return "pending";
    return info.receipt?.result === "SUCCESS" ? "confirmed" : "failed";
  },

  async estimateFee(input) {
    if (input.asset !== "TRX") throw new Error("TRC-20 fee estimation is not implemented yet");
    return "0";
  },

  async sendSignedTransaction(signedTx: string) {
    const result = await tron.trx.sendRawTransaction(JSON.parse(signedTx));
    if (!result.result || !result.txid) throw new Error("TRON broadcast failed");
    return { txHash: result.txid };
  },
};
