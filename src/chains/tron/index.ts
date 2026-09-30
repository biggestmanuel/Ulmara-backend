import { TronWeb } from "tronweb";
import { env } from "../../config/env.js";
import { fromBaseUnits, toBaseUnits } from "../../utils/money.js";
import { ProviderUnavailableError, type ChainAdapter } from "../chain.types.js";

const tron = env.TRON_RPC_URL ? new TronWeb({ fullHost: env.TRON_RPC_URL }) : null;
const requireTron = () => tron ?? (() => { throw new ProviderUnavailableError("TRON", "RPC"); })();

/** TRX's base unit is the sun: 1 TRX = 1e6 sun. */
const SUN_DECIMALS = 6;

/**
 * `tronweb`'s `sendTrx(to, amount: number, from)` takes a JS `number`, so an
 * amount above `Number.MAX_SAFE_INTEGER` sun cannot be handed to it without
 * silently changing the amount. That ceiling is 2^53-1 sun, i.e. about
 * 9,007,199,254 TRX — roughly a tenth of TRX's total supply, so it is a real
 * (if remote) limit rather than a theoretical one. The adapter refuses such an
 * amount instead of building a transaction for a different value.
 */
const MAX_EXACT_SUN = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_EXACT_TRX = MAX_EXACT_SUN / 1_000_000n;

export const tronAdapter: ChainAdapter = {
  chain: "TRON",

  isValidAddress(address: string): boolean {
    // Tron addresses start with T, base58, 34 chars
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  },

  async getBalance(address, asset) {
    // Only the native path is implemented; the chain's own symbol is native.
    if (asset && asset !== "TRX") throw new Error("TRC-20 balance reads are not implemented yet");
    // `trx.getBalance` returns sun as a JS `number` (tronweb's contract). We
    // stringify that integer exactly instead of dividing it by 1e6, which used
    // to truncate. The whole plausible TRX supply (≈1e8 TRX = 1e14 sun) sits
    // below 2^53 (≈9.0e15), so this is exact in practice.
    return fromBaseUnits(BigInt(await requireTron().trx.getBalance(address)), SUN_DECIMALS);
  },

  async buildTransaction(input) {
    if (input.asset !== "TRX") throw new Error("TRON adapter supports native TRX only");
    // Exact string -> sun conversion. `sendTrx` then takes a `number`, so this
    // is the one place an exact bigint is narrowed.
    const sun = toBaseUnits(input.amount, SUN_DECIMALS);
    if (sun > MAX_EXACT_SUN) {
      // Better to refuse than to build a transaction for a different amount
      // than the user asked for. See src/utils/money.ts.
      throw new Error(
        `TRON amount exceeds the exact range of tronweb's sendTrx (max ${MAX_EXACT_TRX.toLocaleString("en-US")} TRX)`,
      );
    }
    return requireTron().transactionBuilder.sendTrx(input.toAddress, Number(sun), input.fromAddress);
  },

  async sendTransaction(signedTx) {
    if (typeof signedTx !== "string") throw new Error("Signed TRON transaction must be serialized JSON");
    return this.sendSignedTransaction!(signedTx);
  },

  async getTransactionStatus(txHash) {
    const info = await requireTron().trx.getTransactionInfo(txHash);
    if (!info?.id) return "pending";
    return info.receipt?.result === "SUCCESS" ? "confirmed" : "failed";
  },

  async estimateFee(input) {
    if (input.asset !== "TRX") throw new Error("TRC-20 fee estimation is not implemented yet");
    throw new ProviderUnavailableError("TRON", "fee estimation");
  },

  async sendSignedTransaction(signedTx: string) {
    const result = await requireTron().trx.sendRawTransaction(JSON.parse(signedTx));
    if (!result.result || !result.txid) throw new Error("TRON broadcast failed");
    return { txHash: result.txid };
  },
};
