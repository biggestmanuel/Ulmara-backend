import { verifyOnChain, Chain } from '@tribridge/triverify';
import { verifyOnChainFallback, FallbackChain } from './evmFallback.js';
import { env } from '../config/env.js';

/**
 * Lowercase ChainId used across the app (matches constants/chains.ts).
 * Routes to TriVerify for the 6 chains it supports, and the local
 * fallback for bsc/base until TriVerify adds them natively.
 */
export type ChainId = 'eth' | 'bsc' | 'base' | 'polygon' | 'sol' | 'tron' | 'ton' | 'btc';

const TRIVERIFY_CHAIN_MAP: Partial<Record<ChainId, Chain>> = {
  eth: Chain.Ethereum,
  polygon: Chain.Polygon,
  sol: Chain.Solana,
  tron: Chain.Tron,
  ton: Chain.Ton,
  btc: Chain.Bitcoin,
};

const FALLBACK_CHAINS: ChainId[] = ['bsc', 'base'];

export async function verifyAddressOnChain(address: string, chainId: ChainId) {
  if (FALLBACK_CHAINS.includes(chainId)) {
    return verifyOnChainFallback(address, chainId as FallbackChain, {
      rpcUrl: chainId === 'bsc' ? env.BSC_RPC_URL : env.BASE_RPC_URL,
    });
  }

  const triverifyChain = TRIVERIFY_CHAIN_MAP[chainId];
  if (!triverifyChain) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }

  const rpcUrl = ({ eth: env.ETHEREUM_RPC_URL, polygon: env.POLYGON_RPC_URL,
    sol: env.SOLANA_RPC_URL, tron: env.TRON_RPC_URL, ton: env.TON_RPC_URL } as Record<string, string | undefined>)[chainId];
  return verifyOnChain(address, triverifyChain, {
    rpcUrl,
    apiKey: env.TRIVERIFY_API_KEY,
    timeoutMs: 8_000,
  });
}
