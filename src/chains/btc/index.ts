import type { ChainAdapter } from "../chain.types.js";
import { ProviderUnavailableError } from "../chain.types.js";
import { env } from "../../config/env.js";

// Bitcoin signing/broadcasting requires a configured node or provider. Keep
// this adapter deliberately non-custodial: callers provide a signed raw tx.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{26,62}$/;
const BECH32 = /^(bc1|tb1)[023456789ac-hj-np-z]{11,87}$/;

export const bitcoinAdapter: ChainAdapter = {
  chain: "BTC",
  isValidAddress(address) {
    return BASE58.test(address) || BECH32.test(address);
  },
  async getBalance(address) {
    const result = await rpc("getreceivedbyaddress", [address, 0]);
    return String(result);
  },
  async buildTransaction() {
    throw new ProviderUnavailableError("BTC", "transaction construction");
  },
  async sendTransaction(signedTx) {
    if (typeof signedTx !== "string") throw new Error("Signed BTC transaction must be serialized hex");
    return { txHash: String(await rpc("sendrawtransaction", [signedTx])) };
  },
  async sendSignedTransaction(signedTx: string) {
    if (!signedTx) throw new Error("Signed BTC transaction is required");
    return { txHash: String(await rpc("sendrawtransaction", [signedTx])) };
  },
  async getTransactionStatus(txHash) {
    const result = await rpc("getrawtransaction", [txHash, true]) as { confirmations?: number };
    return (result.confirmations ?? 0) > 0 ? "confirmed" : "pending";
  },
  async estimateFee() {
    const result = await rpc("estimatesmartfee", [6]) as { feerate?: number };
    if (typeof result.feerate !== "number") throw new Error("BTC node did not return a fee estimate");
    return String(result.feerate);
  },
};

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  if (!env.BTC_RPC_URL) throw new ProviderUnavailableError("BTC", "RPC");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.BTC_RPC_USER || env.BTC_RPC_PASSWORD) {
    headers.authorization = `Basic ${Buffer.from(`${env.BTC_RPC_USER ?? ""}:${env.BTC_RPC_PASSWORD ?? ""}`).toString("base64")}`;
  }
  const response = await fetch(env.BTC_RPC_URL, {
    method: "POST", headers, body: JSON.stringify({ jsonrpc: "1.0", id: "avora", method, params }),
  });
  if (!response.ok) throw new Error(`BTC RPC HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "BTC RPC error");
  return body.result;
}
