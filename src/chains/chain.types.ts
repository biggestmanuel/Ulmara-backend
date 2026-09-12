// Shared interface every chain adapter implements

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

  getTransactionStatus(txHash: string): Promise<"pending" | "confirmed" | "failed">;

  estimateFee(input: {
    fromAddress: string;
    toAddress: string;
    asset: string;
    amount: string;
  }): Promise<string>;

  sendSignedTransaction?(signedTx: string): Promise<{ txHash: string }>;
}
