import { prisma } from "../../config/database.js";
import { getChainAdapter, CHAIN_NAMES, type ChainName } from "../../chains/index.js";
import type { ChainAdapter } from "../../chains/chain.types.js";
import { logger } from "../../config/logger.js";

// The client (lib/registerWallets.ts) sends exactly these uppercase wire
// identifiers for POST /api/wallet/register.
const SUPPORTED_CHAINS: ChainName[] = [...CHAIN_NAMES];

export const walletService = {
  /**
   * Balances for every registered wallet: the native gas asset plus every
   * ERC-20 token configured for that chain's CURRENT network.
   *
   * Each balance is independent — a token RPC failure reports that token as
   * unavailable rather than hiding the native balance, and one unavailable
   * chain never hides the others.
   */
  async getBalances(userId: string) {
    const wallets = await prisma.wallet.findMany({ where: { userId } });

    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const adapter = await getChainAdapter(wallet.chain);
          const native = await adapter.getBalance(wallet.address);
          const tokens = await this.getTokenBalances(adapter, wallet.chain, wallet.address);
          return { chain: wallet.chain, address: wallet.address, balance: native, tokens };
        } catch (err) {
          logger.warn({ chain: wallet.chain, err }, "Chain balance provider unavailable");
          return { chain: wallet.chain, address: wallet.address, balance: null, tokens: [] };
        }
      })
    );

    return results;
  },

  /** Per-token balances; a failing token is reported, never thrown. */
  async getTokenBalances(adapter: ChainAdapter, chain: ChainName, address: string) {
    const configured = adapter.listTokens?.() ?? [];
    if (configured.length === 0 || !adapter.getTokenBalance) return [];
    return Promise.all(
      configured.map(async (token) => {
        try {
          const balance = await adapter.getTokenBalance!(address, token.symbol);
          return {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            address: token.address,
            balance,
          };
        } catch (err) {
          logger.warn({ chain, token: token.symbol, err }, "Token balance provider unavailable");
          return {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            address: token.address,
            balance: null,
          };
        }
      }),
    );
  },

  /** Token metadata for a chain — lets a client render only valid assets. */
  async listSupportedTokens(chain: ChainName) {
    const adapter = await getChainAdapter(chain);
    return (adapter.listTokens?.() ?? []).map((token) => ({
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      address: token.address,
    }));
  },

  async getAddresses(userId: string) {
    return prisma.wallet.findMany({
      where: { userId },
      select: { chain: true, address: true },
    });
  },

  async resolveAccountId(accountId: string) {
    const record = await prisma.accountId.findUnique({
      where: { accountId },
      include: { user: { include: { wallets: true } } },
    });
    if (!record) throw Object.assign(new Error("Account ID not found"), { statusCode: 404 });

    return {
      accountId: record.accountId,
      name: record.user.name,
      photoUrl: record.user.photoUrl,
      wallets: record.user.wallets.map((w) => ({ chain: w.chain, address: w.address })),
    };
  },

  /**
   * Upserts Wallet rows for a user from client-generated public addresses.
   * The backend NEVER receives or stores private keys/mnemonics —
   * non-custodial by construction. Wallet model already has
   * @@unique([userId, chain]) so this is a safe idempotent upsert.
   */
  async registerWallets(userId: string, addresses: { chain: ChainName; address: string }[]) {
    const invalid = addresses.filter((a) => !SUPPORTED_CHAINS.includes(a.chain));
    if (invalid.length > 0) {
      throw Object.assign(
        new Error(`Unsupported chain(s): ${invalid.map((a) => a.chain).join(", ")}`),
        { statusCode: 400 }
      );
    }
    if (new Set(addresses.map((a) => a.chain)).size !== addresses.length) {
      throw Object.assign(new Error("Only one wallet per chain may be registered"), { statusCode: 400 });
    }
    for (const { chain, address } of addresses) {
      const adapter = await getChainAdapter(chain);
      if (!adapter.isValidAddress(address)) {
        throw Object.assign(new Error(`Invalid ${chain} wallet address`), { statusCode: 400 });
      }
    }

    const missing = SUPPORTED_CHAINS.filter((chain) => !addresses.some((a) => a.chain === chain));
    if (missing.length > 0) {
      throw Object.assign(
        new Error(`Missing address(es) for required chain(s): ${missing.join(", ")}`),
        { statusCode: 400 }
      );
    }

    const results = await prisma.$transaction(
      addresses.map(({ chain, address }) =>
        prisma.wallet.upsert({
          where: { userId_chain: { userId, chain } },
          update: { address },
          create: { userId, chain, address },
        })
      )
    );

    return results.map((w) => ({ chain: w.chain, address: w.address }));
  },
};
