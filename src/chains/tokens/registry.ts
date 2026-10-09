import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { getEvmChainId, type ChainName } from "../chain.network.js";

/**
 * ERC-20 token registry.
 *
 * Addresses and decimals live HERE, in one configuration-driven table, and
 * nowhere in business logic. Every consumer resolves a token through
 * `resolveToken(chain, asset)`.
 *
 * Provenance of the defaults below: each address was read on-chain
 * (eth_getCode + decimals()/symbol()/name()) against a public RPC for the
 * network it is listed under. The on-chain `decimals()` value is what is
 * recorded, which matters because it is NOT uniform: Tether/Circle issue 6
 * decimals on Ethereum, but the Binance-Pegged USDT and USDC on BSC are
 * 18-decimal contracts. Hardcoding "stablecoins are 6 decimals" would
 * silently send 10^12 times too much.
 *
 * Tether does not issue USDT on Sepolia, Base Sepolia or Polygon Amoy, and
 * Circle does not issue USDC on BSC Testnet, so those pairings are absent by
 * design rather than guessed. To add or correct any token, set
 * ERC20_TOKEN_CONFIG (JSON) — see parseTokenOverrides.
 */

export interface TokenConfig {
  /** UPPERCASE wire identifier the client sends as `asset`. */
  symbol: string;
  /** Human name, e.g. "USD Coin". */
  name: string;
  decimals: number;
  /** Checksummed contract address for THIS network. */
  address: string;
  chain: ChainName;
  /** Chain id this entry is bound to; prevents a mainnet address being used on testnet. */
  chainId: number;
  /** True when the address/decimals came from an on-chain read. */
  verified?: boolean;
}

const ETH = "ETH" as ChainName;
const BSC = "BSC" as ChainName;
const BASE = "BASE" as ChainName;
const POLYGON = "POLYGON" as ChainName;

interface Seed {
  chain: ChainName;
  chainId: () => number;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  verified: boolean;
}

/**
 * Seed registry. Keyed by chain; each chain may have several networks, so
 * entries are matched on the chain id in effect at lookup time.
 */
const SEEDS: Seed[] = [
  // --- Ethereum mainnet (1) ---------------------------------------------
  {
    chain: ETH,
    chainId: () => 1,
    symbol: "USDC",
    name: "USD Coin",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    verified: true,
  },
  {
    chain: ETH,
    chainId: () => 1,
    symbol: "USDT",
    name: "Tether USD",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    verified: true,
  },

  // --- Ethereum Sepolia (11155111) --------------------------------------
  // Circle's faucet USDC. Tether issues no Sepolia USDT.
  {
    chain: ETH,
    chainId: () => 11155111,
    symbol: "USDC",
    name: "USD Coin",
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    decimals: 6,
    verified: true,
  },

  // --- BSC mainnet (56) --------------------------------------------------
  // NOTE: these are Binance-Pegged and report 18 decimals, unlike the same
  // tickers on Ethereum. Verified on-chain.
  {
    chain: BSC,
    chainId: () => 56,
    symbol: "USDT",
    name: "Binance-Peg Tether USD",
    address: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
    verified: true,
  },
  {
    chain: BSC,
    chainId: () => 56,
    symbol: "USDC",
    name: "Binance-Peg USD Coin",
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
    verified: true,
  },

  // --- Base mainnet (8453) ----------------------------------------------
  {
    chain: BASE,
    chainId: () => 8453,
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    verified: true,
  },
  // --- Base Sepolia (84532) ---------------------------------------------
  {
    chain: BASE,
    chainId: () => 84532,
    symbol: "USDC",
    name: "USD Coin",
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    verified: true,
  },

  // --- Polygon mainnet (137) --------------------------------------------
  {
    chain: POLYGON,
    chainId: () => 137,
    symbol: "USDC",
    name: "USD Coin",
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals: 6,
    verified: true,
  },
  // --- Polygon Amoy (80002) ---------------------------------------------
  {
    chain: POLYGON,
    chainId: () => 80002,
    symbol: "USDC",
    name: "USD Coin",
    address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    decimals: 6,
    verified: true,
  },
];

/** Shape accepted in the ERC20_TOKEN_CONFIG environment variable. */
export interface TokenOverride {
  chain: string;
  chainId?: number;
  symbol: string;
  name?: string;
  address: string;
  decimals: number;
}

let overrides: TokenOverride[] | null = null;

/**
 * Parses ERC20_TOKEN_CONFIG. A malformed value is ignored with a loud warning
 * rather than crashing the process: a bad token entry must not take the API
 * down, and the built-in verified seeds still apply.
 */
function loadOverrides(): TokenOverride[] {
  if (overrides) return overrides;
  const raw = env.ERC20_TOKEN_CONFIG;
  if (!raw) {
    overrides = [];
    return overrides;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
    const valid = parsed.filter((entry): entry is TokenOverride => {
      const e = entry as TokenOverride;
      return (
        typeof e?.chain === "string" &&
        typeof e?.symbol === "string" &&
        typeof e?.address === "string" &&
        Number.isInteger(e?.decimals) &&
        // A 0x-prefixed 20-byte hex address, nothing looser.
        /^0x[0-9a-fA-F]{40}$/.test(e.address)
      );
    });
    if (valid.length !== parsed.length) {
      // Surface the dropped entries rather than silently half-applying.
      const dropped = parsed.length - valid.length;
      logger.warn(
        {
          event: "erc20_token_config_invalid_entries",
          dropped,
          accepted: valid.length,
          requirement: "{ chain, symbol, address (0x + 40 hex), decimals }",
        },
        `[ERC20_TOKEN_CONFIG] ignored ${dropped} malformed entr${dropped === 1 ? "y" : "ies"}`,
      );
    }
    overrides = valid;
  } catch (err) {
    logger.warn(
      { event: "erc20_token_config_unparseable", err: err instanceof Error ? err.message : String(err) },
      "[ERC20_TOKEN_CONFIG] could not be parsed and was ignored",
    );
    overrides = [];
  }
  return overrides;
}

/** Test seam. */
export function resetTokenOverrides(): void {
  overrides = null;
}

/**
 * Every token configured for a chain.
 *
 * `chainIdOverride` exists because an adapter may be constructed bound to a
 * specific chain id; it must be able to ask "what is configured for MY
 * network" without relying on the process-wide env value agreeing with it.
 * Non-EVM chains (and any chain id with nothing configured) return [].
 */
export function listTokens(chain: ChainName, chainIdOverride?: number): TokenConfig[] {
  let configured: number;
  try {
    configured = chainIdOverride ?? getEvmChainId(chain);
  } catch {
    // Not an EVM chain: no ERC-20 registry applies.
    return [];
  }

  const fromSeeds = SEEDS.filter((seed) => seed.chain === chain && seed.chainId() === configured).map(
    (seed): TokenConfig => ({
      symbol: seed.symbol,
      name: seed.name,
      address: seed.address,
      decimals: seed.decimals,
      chain,
      chainId: configured,
      verified: seed.verified,
    }),
  );

  // An override for the same symbol on the same network wins over the seed.
  const bySymbol = new Map<string, TokenConfig>();
  for (const token of [...fromSeeds, ...applyOverrides(chain, configured)]) bySymbol.set(token.symbol, token);
  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function applyOverrides(chain: ChainName, chainId: number): TokenConfig[] {
  return loadOverrides()
    .filter((entry) => entry.chain.toUpperCase() === chain && (entry.chainId === undefined || entry.chainId === chainId))
    .map(
      (entry): TokenConfig => ({
        symbol: entry.symbol.toUpperCase(),
        name: entry.name ?? entry.symbol.toUpperCase(),
        address: entry.address,
        decimals: entry.decimals,
        chain,
        chainId,
        verified: false,
      }),
    );
}

/** Resolves a token by its UPPERCASE symbol on a chain, or null. */
export function resolveToken(
  chain: ChainName,
  asset: string | undefined,
  chainIdOverride?: number,
): TokenConfig | null {
  if (!asset) return null;
  return listTokens(chain, chainIdOverride).find((token) => token.symbol === asset.toUpperCase()) ?? null;
}

/** True when the chain+asset pair names a configured ERC-20 token. */
export function isTokenAsset(chain: ChainName, asset: string, chainIdOverride?: number): boolean {
  return resolveToken(chain, asset, chainIdOverride) !== null;
}

/**
 * Asserts a chain/asset combination and returns the token.
 * Throws a 400 rather than allowing an unconfigured asset to reach a
 * persisted intent or a signed transaction.
 */
export function requireToken(chain: ChainName, asset: string, chainIdOverride?: number): TokenConfig {
  const token = resolveToken(chain, asset, chainIdOverride);
  if (!token) {
    const available = listTokens(chain, chainIdOverride).map((t) => t.symbol);
    const hint = available.length > 0 ? ` Supported on ${chain}: ${available.join(", ")}.` : "";
    throw Object.assign(new Error(`${asset} is not a supported token on ${chain}.${hint}`), { statusCode: 400 });
  }
  return token;
}

/**
 * Rejects a token whose contract address is not valid for the network we are
 * actually pointed at. This is the guard that stops a mainnet USDT address
 * being broadcast on Sepolia (or vice versa) when env is misconfigured.
 */
export function assertTokenMatchesNetwork(token: TokenConfig, expectedChainId: number): void {
  if (token.chainId !== expectedChainId) {
    throw Object.assign(
      new Error(
        `${token.symbol} on ${token.chain} is configured for chain id ${token.chainId}, ` +
          `but this deployment is running chain id ${expectedChainId}`,
      ),
      { statusCode: 500 },
    );
  }
}
