import type { ChainAdapter } from "./chain.types.js";

export type ChainName = "TON" | "BSC" | "ETH" | "SOL" | "BASE" | "POLYGON" | "TRON" | "BTC";

// Single source of truth for the wire-format chain identifier. Every zod
// schema that accepts a chain/network from a client MUST derive its enum
// from this array (see controllers/*.ts), and clients must send exactly
// these uppercase values. Kept in sync with the Prisma `Chain` enum.
export const CHAIN_NAMES = ["TON", "BSC", "ETH", "SOL", "BASE", "POLYGON", "TRON", "BTC"] as const;

// Lazy-loaded to avoid pulling in every chain SDK at server boot
const loaders: Record<ChainName, () => Promise<ChainAdapter>> = {
  TON: async () => (await import("./ton/index.js")).tonAdapter,
  ETH: async () => (await import("./evm/ethereum/index.js")).ethereumAdapter as ChainAdapter,
  BSC: async () => (await import("./evm/bsc/index.js")).bscAdapter as unknown as ChainAdapter,
  BASE: async () => (await import("./evm/base/index.js")).baseAdapter as unknown as ChainAdapter,
  POLYGON: async () => (await import("./evm/polygon/index.js")).polygonAdapter as unknown as ChainAdapter,
  SOL: async () => (await import("./solana/index.js")).solanaAdapter,
  TRON: async () => (await import("./tron/index.js")).tronAdapter,
  BTC: async () => (await import("./btc/index.js")).bitcoinAdapter,
};

export async function getChainAdapter(chain: ChainName): Promise<ChainAdapter> {
  return loaders[chain]();
}
