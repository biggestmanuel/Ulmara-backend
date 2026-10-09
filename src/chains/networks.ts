import { env } from "../config/env.js";
import type { ChainName } from "./index.js";

/**
 * Network profiles for the chains the backend supports.
 *
 * One table describing every deployment target, so a network switch is a
 * configuration change rather than a code change, and so the supported
 * testnet/mainnet set is discoverable in one place (and reportable).
 *
 * `chainId` here is DOCUMENTATION of the well-known id for the network. The
 * id the app actually uses always comes from the environment
 * (getEvmChainId) — never from this table — so this file can never cause a
 * transaction to be built for the wrong network.
 */

export type NetworkKind = "mainnet" | "testnet";

export interface NetworkProfile {
  chain: ChainName;
  network: string;
  kind: NetworkKind;
  chainId: number;
  /** Public reference endpoint; never used automatically, documentation only. */
  referenceRpcUrl?: string;
  /** Env var holding this network's RPC. */
  rpcEnvVar: string;
  /** Env var that selects this network's chain id, if the chain has one. */
  chainIdEnvVar?: string;
  /** Where test coins come from. */
  faucet?: string;
  /** True when the architecture can actually sign/broadcast here today. */
  supported: boolean;
  notes: string;
}

export const NETWORK_PROFILES: NetworkProfile[] = [
  // --- EVM ---------------------------------------------------------------
  {
    chain: "ETH",
    network: "Ethereum Sepolia",
    kind: "testnet",
    chainId: 11155111,
    referenceRpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    rpcEnvVar: "ETHEREUM_RPC_URL",
    chainIdEnvVar: "ETHEREUM_CHAIN_ID",
    // Sepolia ETH is faucet-issued; it must be converted to Sepolia ETH per
    // test coin before it can pay gas.
    faucet: "https://sepoliafaucet.com (or any Sepolia faucet)",
    supported: true,
    notes: "Pilot network. ERC-20 USDC is Circle faucet USDC; Tether issues no Sepolia USDT.",
  },
  {
    chain: "ETH",
    network: "Ethereum",
    kind: "mainnet",
    chainId: 1,
    referenceRpcUrl: "https://ethereum-rpc.publicnode.com",
    rpcEnvVar: "ETHEREUM_RPC_URL",
    chainIdEnvVar: "ETHEREUM_CHAIN_ID",
    supported: true,
    notes: "Go-live target: set ETHEREUM_CHAIN_ID=1. No code change needed.",
  },
  {
    chain: "BSC",
    network: "BNB Smart Chain Testnet",
    kind: "testnet",
    chainId: 97,
    referenceRpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    rpcEnvVar: "BSC_RPC_URL",
    chainIdEnvVar: "BSC_CHAIN_ID",
    // BNB testnet faucet drips BNB.
    faucet: "https://www.bnbchain.org/en/testnet-faucet",
    supported: true,
    notes:
      "Native BNB transfers are supported. No canonical USDT/USDC is deployed for BSC Testnet, " +
      "so add one via ERC20_TOKEN_CONFIG if token coverage is required here.",
  },
  {
    chain: "BSC",
    network: "BNB Smart Chain",
    kind: "mainnet",
    chainId: 56,
    referenceRpcUrl: "https://bsc-rpc.publicnode.com",
    rpcEnvVar: "BSC_RPC_URL",
    chainIdEnvVar: "BSC_CHAIN_ID",
    supported: true,
    notes: "USDT/USDC here are Binance-Pegged and report 18 decimals (unlike the same tickers on Ethereum).",
  },
  {
    chain: "BASE",
    network: "Base Sepolia",
    kind: "testnet",
    chainId: 84532,
    referenceRpcUrl: "https://sepolia.base.org",
    rpcEnvVar: "BASE_RPC_URL",
    chainIdEnvVar: "BASE_CHAIN_ID",
    faucet: "https://portal.cdp.coinbase.com/products/faucet (Base Sepolia ETH + USDC)",
    supported: true,
    notes: "ERC-20 USDC is Circle faucet USDC. Fees are paid in ETH.",
  },
  {
    chain: "BASE",
    network: "Base",
    kind: "mainnet",
    chainId: 8453,
    referenceRpcUrl: "https://base-rpc.publicnode.com",
    rpcEnvVar: "BASE_RPC_URL",
    chainIdEnvVar: "BASE_CHAIN_ID",
    supported: true,
    notes: "Fees are paid in ETH, not BOLD.",
  },
  {
    chain: "POLYGON",
    network: "Polygon PoS Amoy",
    kind: "testnet",
    chainId: 80002,
    referenceRpcUrl: "https://polygon-amoy-bor-rpc.publicnode.com",
    rpcEnvVar: "POLYGON_RPC_URL",
    chainIdEnvVar: "POLYGON_CHAIN_ID",
    faucet: "https://faucet.polygon.technology",
    supported: true,
    notes: "ERC-20 USDC is Circle faucet USDC.",
  },
  {
    chain: "POLYGON",
    network: "Polygon PoS",
    kind: "mainnet",
    chainId: 137,
    referenceRpcUrl: "https://polygon-bor-rpc.publicnode.com",
    rpcEnvVar: "POLYGON_RPC_URL",
    chainIdEnvVar: "POLYGON_CHAIN_ID",
    supported: true,
    notes: "",
  },

  // --- Non-EVM -----------------------------------------------------------
  {
    chain: "SOL",
    network: "Solana Devnet",
    kind: "testnet",
    chainId: 0, // Solana has no EVM chain id; selected by RPC URL
    referenceRpcUrl: "https://api.devnet.solana.com",
    rpcEnvVar: "SOLANA_RPC_URL",
    faucet: "https://faucet.solana.com (2 SOL per request, devnet only)",
    supported: true,
    notes:
      "Network is selected purely by SOLANA_RPC_URL. Native SOL only — SPL token support is not " +
      "implemented. Set SOLANA_RPC_URL=https://api.devnet.solana.com for devnet.",
  },
  {
    chain: "SOL",
    network: "Solana Mainnet",
    kind: "mainnet",
    chainId: 0,
    referenceRpcUrl: "https://api.mainnet-beta.solana.com",
    rpcEnvVar: "SOLANA_RPC_URL",
    supported: true,
    notes: "Set SOLANA_RPC_URL=https://api.mainnet-beta.solana.com.",
  },
  {
    chain: "TRON",
    network: "TRON Shasta (testnet) / Nile",
    kind: "testnet",
    chainId: 0,
    referenceRpcUrl: "https://api.shasta.trongrid.io",
    rpcEnvVar: "TRON_RPC_URL",
    supported: true,
    notes: "Native TRX only. Network is selected by TRON_RPC_URL.",
  },
  {
    chain: "TON",
    network: "TON Testnet",
    kind: "testnet",
    chainId: 0,
    referenceRpcUrl: "https://testnet.ton.org",
    rpcEnvVar: "TON_RPC_URL",
    supported: true,
    notes: "Native TON only. Network is selected by TON_RPC_URL.",
  },
  {
    chain: "BTC",
    network: "Bitcoin (signet/testnet via configured node)",
    kind: "testnet",
    chainId: 0,
    rpcEnvVar: "BTC_RPC_URL",
    supported: true,
    notes:
      "Requires a configured Bitcoin Core JSON-RPC node (BTC_RPC_URL, optional basic-auth " +
      "BTC_RPC_USER/BTC_RPC_PASSWORD). Balance/fee/broadcast/confirmation are implemented; " +
      "transaction construction is client/provider-owned.",
  },
];

export function testnetProfiles(): NetworkProfile[] {
  return NETWORK_PROFILES.filter((p) => p.kind === "testnet");
}

/** Env var holding each chain's RPC endpoint. */
export const RPC_ENV_VAR_BY_CHAIN: Record<string, string> = {
  ETH: "ETHEREUM_RPC_URL",
  BSC: "BSC_RPC_URL",
  BASE: "BASE_RPC_URL",
  POLYGON: "POLYGON_RPC_URL",
  SOL: "SOLANA_RPC_URL",
  TRON: "TRON_RPC_URL",
  TON: "TON_RPC_URL",
  BTC: "BTC_RPC_URL",
};

/**
 * Which RPC (if any) is configured for a chain right now. Used by the
 * operational config endpoint so support can see what a deployment points at.
 */
export function rpcConfiguredFor(chain: ChainName): boolean {
  const key = RPC_ENV_VAR_BY_CHAIN[chain];
  return Boolean(key && (env as Record<string, unknown>)[key]);
}

/** Validates the current configuration and returns human-readable problems. */
export function validateNetworkConfiguration(): string[] {
  const problems: string[] = [];

  // Every configured EVM chain id must correspond to a network we actually
  // know about. An unrecognised id usually means a typo, and a typo is how a
  // deployment ends up building transactions for a network nobody monitors.
  for (const profile of NETWORK_PROFILES) {
    if (!profile.chainIdEnvVar) continue;
    if (!rpcConfiguredFor(profile.chain)) continue; // not deployed here
    const configured = (env as Record<string, unknown>)[profile.chainIdEnvVar];
    if (typeof configured !== "number" || configured <= 0) continue;
    if (configured === profile.chainId) continue;
    const known = NETWORK_PROFILES.some(
      (p) => p.chainIdEnvVar === profile.chainIdEnvVar && p.chainId === configured,
    );
    if (!known) {
      problems.push(
        `${profile.chainIdEnvVar}=${configured} matches no known ${profile.chain} network ` +
          `(known: ${NETWORK_PROFILES.filter((p) => p.chainIdEnvVar === profile.chainIdEnvVar)
            .map((p) => `${p.chainId} (${p.network})`)
            .join(", ")}).`,
      );
    }
  }

  // A chain with no RPC cannot serve balances, fees or broadcasts.
  for (const chain of Object.keys(RPC_ENV_VAR_BY_CHAIN) as ChainName[]) {
    if (!rpcConfiguredFor(chain)) {
      problems.push(
        `${RPC_ENV_VAR_BY_CHAIN[chain]} is not set: ${chain} balance, fee and broadcast operations will fail.`,
      );
    }
  }

  return problems;
}
