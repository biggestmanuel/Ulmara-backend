import { env } from "../config/env.js";
import type { ChainName } from "./index.js";

export type { ChainName };

/**
 * The EVM chains this module can answer for. Deliberately a local constant
 * rather than a derivation from CHAIN_NAMES: importing chains/index.js here
 * would pull the lazy chain-adapter loaders (and every chain SDK) into every
 * module that needs a chain id.
 */
const EVM_CHAINS = ["ETH", "BSC", "BASE", "POLYGON"] as const;
export type EvmChainName = (typeof EVM_CHAINS)[number];

function isEvmChainName(chain: string): chain is EvmChainName {
  return (EVM_CHAINS as readonly string[]).includes(chain);
}

/**
 * Single source of truth for the EVM chain id each network is currently
 * pointed at. Every consumer (adapter construction, signed-transaction
 * verification, token registry) reads it from here so a network switch is a
 * config change and never a code change.
 */
export function getEvmChainId(chain: string): number {
  if (!isEvmChainName(chain)) {
    throw Object.assign(new Error(`Not an EVM chain: ${chain}`), { statusCode: 400 });
  }
  switch (chain) {
    case "ETH":
      return env.ETHEREUM_CHAIN_ID;
    case "BSC":
      return env.BSC_CHAIN_ID ?? 56;
    case "BASE":
      return env.BASE_CHAIN_ID ?? 8453;
    case "POLYGON":
      return env.POLYGON_CHAIN_ID ?? 137;
  }
}

export function isEvmChain(chain: string): boolean {
  return isEvmChainName(chain);
}

/** Native gas asset per chain (Base settles fees in ETH). */
export function nativeAssetFor(chain: string): string | undefined {
  return (
    {
      TON: "TON",
      BSC: "BNB",
      ETH: "ETH",
      SOL: "SOL",
      BASE: "ETH",
      POLYGON: "POL",
      TRON: "TRX",
      BTC: "BTC",
    } as Record<string, string | undefined>
  )[chain];
}
