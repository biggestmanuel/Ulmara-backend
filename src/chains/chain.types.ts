export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  constructor(chain: string, operation: string) {
    super(`${chain} ${operation} provider is not configured`);
    this.name = "ProviderUnavailableError";
  }
}

export type TransactionStatus = "pending" | "confirmed" | "failed";

/** A fully-specified ERC-20 transfer, ready for a client wallet to sign. */
export interface TokenTransferPlan {
  kind: "erc20";
  chain: string;
  chainId: number;
  token: {
    symbol: string;
    name: string;
    decimals: number;
    address: string;
  };
  /** The token CONTRACT (not the recipient) — that is where the call goes. */
  to: string;
  /** Checksummed recipient, for the client to show and us to verify. */
  recipient: string;
  /** Always 0 for a token transfer. */
  value: string;
  /** transfer(recipient, amount) calldata. */
  data: string;
  gasLimit: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
}

export interface ChainAdapter {
  chain: string;

  isValidAddress(address: string): boolean;

  /**
   * Balance of `asset` on this chain. `asset` may be the native coin or a
   * configured ERC-20 symbol.
   */
  getBalance(address: string, asset?: string): Promise<string>;

  /** Native gas-asset balance, independent of any token. */
  getNativeBalance?(address: string): Promise<string>;

  /** ERC-20 tokens configured for this chain's CURRENT network. */
  listTokens?(): TokenMetadata[];

  resolveToken?(asset: string): TokenMetadata | null;

  getTokenBalance?(address: string, asset: string): Promise<string>;

  /** Can this address cover `requiredNative` in gas? */
  canPayGas?(address: string, requiredNative: string): Promise<boolean>;

  buildTransaction(input: {
    fromAddress: string;
    toAddress: string;
    asset: string;
    amount: string;
  }): Promise<unknown>;

  buildTokenTransfer?(input: {
    fromAddress: string;
    toAddress: string;
    asset: string;
    amount: string;
  }, token?: TokenMetadata): Promise<TokenTransferPlan>;

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
