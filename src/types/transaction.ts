import type { ChainName } from "../chains/index.js";

export interface SendTransactionInput {
  senderId: string;
  recipientAccountId?: string;
  recipientAddress?: string;
  asset: string;
  amount: string;
  network: ChainName;
}
