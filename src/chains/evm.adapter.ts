type ChainAdapter = {
  chain: string;
  isValidAddress(address: string): boolean;
  getBalance(address: string, asset?: string): Promise<string>;
  buildTransaction(input: unknown): Promise<unknown>;
  sendTransaction(signedTx: unknown): Promise<unknown>;
  getTransactionStatus(txHash: string): Promise<unknown>;
  estimateFee(input: unknown): Promise<unknown>;
};

// Shared EVM logic. Each concrete chain (ethereum/bsc/base/polygon) configures
// this with its own RPC URL and chain ID once ethers/viem is wired in.
export function createEvmAdapter(chainName: string, rpcUrl: string): ChainAdapter {
  return {
    chain: chainName,

    isValidAddress(address: string): boolean {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    },

    async getBalance(address: string, asset?: string): Promise<string> {
      throw new Error("Not implemented");
    },

    async buildTransaction(input) {
      throw new Error("Not implemented");
    },

    async sendTransaction(signedTx) {
      throw new Error("Not implemented");
    },

    async getTransactionStatus(txHash: string) {
      throw new Error("Not implemented");
    },

    async estimateFee(input) {
      throw new Error("Not implemented");
    },
  };
}
