import { Address, TonClient } from "@ton/ton";
import { env } from "../../config/env.js";
import type { ChainAdapter } from "../chain.types.js";

const client = new TonClient({ endpoint: env.TON_RPC_URL ?? "https://toncenter.com/api/v2/jsonRPC" });

export const tonAdapter: ChainAdapter = {
  chain: "TON",

  isValidAddress(address: string): boolean {
    // TON addresses are base64/base64url, 48 chars
    return /^[A-Za-z0-9_-]{48}$/.test(address);
  },

  async getBalance(address, asset) {
    if (asset) throw new Error("Jetton balance reads are not implemented yet");
    const balance = await client.getBalance(Address.parse(address));
    return Number(balance) / 1e9 + "";
  },

  async buildTransaction(input) {
    if (input.asset !== "TON") throw new Error("TON adapter supports native TON only");
    return { to: Address.parse(input.toAddress).toRawString(), amountNano: BigInt(Math.round(Number(input.amount) * 1e9)).toString() };
  },

  async sendTransaction(signedTx) {
    if (typeof signedTx !== "string") throw new Error("Signed TON transaction must be base64 BOC");
    return this.sendSignedTransaction!(signedTx);
  },

  async getTransactionStatus(txHash) {
    if (!txHash) return "pending";
    return "pending";
  },

  async estimateFee(input) {
    if (input.asset !== "TON") throw new Error("Jetton fee estimation is not implemented yet");
    return "0";
  },

  async sendSignedTransaction(signedTx: string) {
    await client.sendFile(Buffer.from(signedTx, "base64"));
    return { txHash: signedTx };
  },
};
