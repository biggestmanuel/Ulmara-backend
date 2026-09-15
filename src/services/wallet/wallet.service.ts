import { prisma } from "../../config/database.js";
import { getChainAdapter, type ChainName } from "../../chains/index.js";
import { logger } from "../../config/logger.js";

const SUPPORTED_CHAINS: ChainName[] = ["ETH", "BSC", "BASE", "POLYGON", "TRON", "SOL", "TON"];

export const walletService = {
  async getBalances(userId: string) {
    const wallets = await prisma.wallet.findMany({ where: { userId } });

    // Chain adapters' getBalance() isn't implemented yet (needs RPC wiring per chain),
    // so we return each wallet with balance: null rather than fail the whole request.
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          const adapter = await getChainAdapter(wallet.chain as ChainName);
          const balance = await adapter.getBalance(wallet.address);
          return { chain: wallet.chain, address: wallet.address, balance };
        } catch (err) {
          logger.warn({ chain: wallet.chain, err }, "Balance fetch not yet available for chain");
          return { chain: wallet.chain, address: wallet.address, balance: null };
        }
      })
    );

    return results;
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
