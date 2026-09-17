export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  constructor(chain: string, operation: string) {
    super(`${chain} ${operation} provider is not configured`);
    this.name = "ProviderUnavailableError";
  }
}

export type TransactionStatus = "pending" | "confirmed" | "failed";

export interface ChainAdapter {
  chain: string;

  isValidAddress(address: string): boolean;

  getBalance(address: string, asset?: string): Promise<string>;

  buildTransaction(input: {
    fromAddress: string;
    toAddress: string;
    asset: string;
    amount: string;
  }): Promise<unknown>;

  sendTransaction(signedTx: unknown): Promise<{ txHash: string }>;

  getTransactionStatus(txHash: string): Promise<TransactionStatus>;

  estimateFee(input: {
    fromAddress: string;
    toAddress: string;
    asset: string;
    amount: string;
  }): Promise<string>;

  sendSignedTransaction?(signedTx: string): Promise<{ txHash: string }>;
}
