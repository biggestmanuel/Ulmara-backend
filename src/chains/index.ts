import type { ChainAdapter } from "./chain.types.js";

export type ChainName = "TON" | "BSC" | "ETH" | "SOL" | "BASE" | "POLYGON" | "TRON";

// Lazy-loaded to avoid pulling in every chain SDK at server boot
const loaders: Record<ChainName, () => Promise<ChainAdapter>> = {
  TON: async () => (await import("./ton/index.js")).tonAdapter,
  ETH: async () => (await import("./evm/ethereum/index.js")).ethereumAdapter as ChainAdapter,
  BSC: async () => (await import("./evm/bsc/index.js")).bscAdapter as unknown as ChainAdapter,
  BASE: async () => (await import("./evm/base/index.js")).baseAdapter as unknown as ChainAdapter,
  POLYGON: async () => (await import("./evm/polygon/index.js")).polygonAdapter as unknown as ChainAdapter,
  SOL: async () => (await import("./solana/index.js")).solanaAdapter,
  TRON: async () => (await import("./tron/index.js")).tronAdapter,
};

export async function getChainAdapter(chain: ChainName): Promise<ChainAdapter> {
  return loaders[chain]();
}
