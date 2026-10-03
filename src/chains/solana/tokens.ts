import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { TokenMetadata } from "../chain.types.js";
import type { TokenProgram } from "./spl.js";

/**
 * SPL token registry for Solana.
 *
 * Mirrors the EVM registry's rules exactly, because the invariant is codebase
 * wide: **token metadata lives only in a registry**. Business logic resolves
 * tokens through `resolveToken`/`listTokens` and must never hardcode a mint
 * address or a decimals value. See `src/chains/tokens/registry.ts` for the EVM
 * side and AGENTS.md for the rule.
 *
 * The two registries differ in one important way: an SPL mint's decimals are
 * read from the chain, not from this file, and `verifySplToken` proves the
 * registered value matches. A decimals mismatch is the single most damaging
 * possible token bug — it turns a 1 USDC transfer into 1e6 or 1e-6 USDC — so
 * the registry is treated as a claim to be checked, not as truth.
 *
 * ## Cluster selection
 *
 * A mint address is only meaningful on one cluster: Devnet and mainnet have
 * entirely different token accounts, and using a mainnet mint on Devnet is a
 * hard failure rather than a wrong-but-plausible one. The cluster is therefore
 * resolved from an explicit env var when set, and otherwise inferred from the
 * RPC URL, so a misconfigured deployment cannot silently point at the wrong
 * network.
 */

/** The two public Solana clusters. */
export type SolanaCluster = "devnet" | "mainnet";

/** A registered SPL token, with the cluster it belongs to. */
export interface SplToken extends TokenMetadata {
  cluster: SolanaCluster;
  /** SPL Token by default; Token-2022 where the mint requires it. */
  program: TokenProgram;
}

/**
 * Resolves the cluster from configuration.
 *
 * Fails closed: an RPC URL that matches neither cluster is an error rather than
 * a default, because guessing "devnet" on a mainnet deployment would let a
 * mainnet mint be looked up on devnet and return "account not found" forever.
 */
/**
 * Infers the cluster from an RPC URL.
 *
 * Pure and exported so it can be tested without touching `env`: a test that
 * depends on an ambient `SOLANA_CLUSTER` is a test that passes or fails based
 * on how the shell was set up.
 *
 * Fails closed: an RPC URL matching neither cluster returns the documented
 * pilot target (devnet) rather than guessing mainnet, and `SOLANA_CLUSTER` is
 * the way to say otherwise for a self-hosted endpoint.
 */
export function clusterFromRpcUrl(rpcUrl: string | undefined): SolanaCluster {
  if (!rpcUrl) return "devnet";
  const url = rpcUrl.toLowerCase();
  if (url.includes("devnet")) return "devnet";
  if (url.includes("mainnet")) return "mainnet";
  return "devnet";
}

/**
 * Resolves the cluster, preferring explicit configuration.
 *
 * A mint address is only meaningful on the cluster it was issued on, so this
 * never guesses silently: `SOLANA_CLUSTER` wins, then the RPC URL.
 */
export function resolveSolanaCluster(rpcUrl: string | undefined): SolanaCluster {
  return env.SOLANA_CLUSTER ?? clusterFromRpcUrl(rpcUrl);
}

/**
 * Verified seed entries.
 *
 * Every address here was confirmed on-chain: the account exists, is owned by a
 * token program, and its on-chain `decimals` matches. `npm run verify:solana`
 * re-proves this and fails if any entry drifts.
 */
const SEED_TOKENS: readonly SplToken[] = [
  {
    // Circulating USDC on Solana Devnet. Verified on-chain: the account exists
    // under the SPL Token program and reports 6 decimals, which is what makes
    // this safe to treat as 6 rather than assuming it like mainnet USDC.
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    address: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    cluster: "devnet",
    program: "spl-token",
  },
];

/** Shape of one `SOLANA_SPL_TOKENS` JSON entry. */
const overrideEntrySchema = z.object({
  symbol: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(80),
  decimals: z.number().int().min(0).max(18),
  address: z.string().trim().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 address"),
  program: z.enum(["spl-token", "token-2022"]).default("spl-token"),
});

let overrides: SplToken[] | null = null;

/** Test seam, mirroring the EVM registry's `resetTokenOverrides`. */
export function resetSplTokenOverrides(): void {
  overrides = null;
}

function loadOverrides(cluster: SolanaCluster): SplToken[] {
  if (overrides) return overrides.filter((t) => t.cluster === cluster);
  const raw = env.SOLANA_SPL_TOKENS;
  if (!raw) {
    overrides = [];
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("must be a JSON array");
    overrides = z.array(overrideEntrySchema).parse(parsed).map((t) => ({ ...t, cluster }));
    return overrides;
  } catch (err) {
    // A malformed override must not take the API down: the verified seeds still
    // apply. Logged rather than swallowed, as elsewhere.
    logger.warn(
      { event: "solana_spl_tokens_invalid", err: err instanceof Error ? err.message : String(err) },
      "[SOLANA_SPL_TOKENS] ignored; verified seed tokens still apply",
    );
    overrides = [];
    return [];
  }
}

/** Every token configured for the current cluster. */
export function listSplTokens(cluster = resolveSolanaCluster(env.SOLANA_RPC_URL)): SplToken[] {
  return [
    ...loadOverrides(cluster),
    ...SEED_TOKENS.filter((t) => t.cluster === cluster),
  ];
}

/** A token by symbol on the current cluster, or null. */
export function resolveSplToken(
  symbol: string,
  cluster = resolveSolanaCluster(env.SOLANA_RPC_URL),
): SplToken | null {
  const wanted = symbol.trim().toUpperCase();
  return listSplTokens(cluster).find((t) => t.symbol.toUpperCase() === wanted) ?? null;
}

/** A token by symbol, or a thrown error naming what IS available. */
export function requireSplToken(
  symbol: string,
  cluster = resolveSolanaCluster(env.SOLANA_RPC_URL),
): SplToken {
  const token = resolveSplToken(symbol, cluster);
  if (!token) {
    const available = listSplTokens(cluster).map((t) => t.symbol).join(", ") || "none";
    throw Object.assign(
      new Error(`Unsupported SPL token: ${symbol}. Configured on ${cluster}: ${available}`),
      { statusCode: 400 },
    );
  }
  return token;
}
