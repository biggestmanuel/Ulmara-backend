import { ethers } from "ethers";
import type { ChainAdapter } from "./chain.types.js";

const CHAIN_CONFIG: Record<string, { chainId: number; decimals: number }> = {
  ETH: { chainId: 1, decimals: 18 },
  BSC: { chainId: 56, decimals: 18 },
  BASE: { chainId: 8453, decimals: 18 },
  POLYGON: { chainId: 137, decimals: 18 },
};

type NativeTransfer = {
  fromAddress: string;
  toAddress: string;
  asset: string;
  amount: string;
};

// Shared EVM logic. Each concrete chain (ethereum/bsc/base/polygon) configures
// this with its own RPC URL and chain ID once ethers/viem is wired in.
export function createEvmAdapter(chainName: string, rpcUrl: string, chainIdOverride?: number): ChainAdapter {
  const config = CHAIN_CONFIG[chainName];
  if (!config) throw new Error(`Unsupported EVM chain: ${chainName}`);
  const chainId = chainIdOverride ?? config.chainId;
  const provider = new ethers.JsonRpcProvider(rpcUrl || "https://cloudflare-eth.com", chainId);
  const sendSigned = async (signedTx: string) => {
    const response = await provider.broadcastTransaction(signedTx);
    return { txHash: response.hash };
  };

  return {
    chain: chainName,

    isValidAddress(address: string): boolean {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    },

    async getBalance(address: string, asset?: string): Promise<string> {
      if (asset) throw new Error("ERC-20 balance reads are not implemented yet");
      return ethers.formatUnits(await provider.getBalance(address), config.decimals);
    },

    async buildTransaction(input: NativeTransfer) {
      if (input.asset !== chainName && !(chainName === "BASE" && input.asset === "ETH")) {
        throw new Error(`Native EVM adapter cannot transfer ${input.asset} on ${chainName}`);
      }
      const feeData = await provider.getFeeData();
      return {
        from: input.fromAddress,
        to: ethers.getAddress(input.toAddress),
        value: ethers.parseUnits(input.amount, config.decimals),
        chainId,
        gasLimit: 21_000n,
        maxFeePerGas: feeData.maxFeePerGas ?? undefined,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
      };
    },

    async sendTransaction(signedTx: unknown) {
      if (typeof signedTx !== "string") throw new Error("Signed EVM transaction must be serialized hex");
      return sendSigned(signedTx);
    },

    async getTransactionStatus(txHash: string) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) return "pending" as const;
      return receipt.status === 1 ? "confirmed" as const : "failed" as const;
    },

    async estimateFee(input: NativeTransfer) {
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
      if (!gasPrice) throw new Error("Unable to estimate gas price");
      return ethers.formatUnits(gasPrice * 21_000n, config.decimals);
    },

    async sendSignedTransaction(signedTx: string) {
      return sendSigned(signedTx);
    },
  };
}
