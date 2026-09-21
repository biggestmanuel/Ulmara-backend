import type { ChainName } from "../chains/index.js";

export interface SendTransactionInput {
  senderId: string;
  recipientAccountId?: string;
  recipientAddress?: string;
  asset: string;
  amount: string;
  network: ChainName;
  /** Authorization PIN, verified server-side before any transaction is created. */
  pin: string;
  /**
   * Client-generated UUID, one per transfer attempt. A repeat request with
   * the same key replays the original transaction instead of creating a new
   * one (mobile network timeout-and-retry, double-tap racing the button).
   */
  idempotencyKey: string;
}
