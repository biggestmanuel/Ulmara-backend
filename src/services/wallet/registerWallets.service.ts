/**
 * services/wallet/registerWallets.service.ts
 *
 * Add this function to your existing wallet.service.ts (or import from here).
 * Upserts Wallet rows for a user from client-generated public addresses.
 * The backend NEVER receives or stores private keys/mnemonics — non-custodial
 * by construction.
 */

import { prisma } from '../../config/database.js';
import type { Chain } from '@prisma/client';

type ChainId =
  | 'ethereum'
  | 'bsc'
  | 'base'
  | 'polygon'
  | 'tron'
  | 'solana'
  | 'ton';

export interface RegisterWalletsInput {
  userId: string;
  addresses: { chain: ChainId; address: string }[];
}

export interface RegisterWalletsResult {
  registered: { chain: ChainId; address: string }[];
}

const SUPPORTED_CHAINS: ChainId[] = [
  'ethereum',
  'bsc',
  'base',
  'polygon',
  'tron',
  'solana',
  'ton',
];

export async function registerWallets(
  input: RegisterWalletsInput
): Promise<RegisterWalletsResult> {
  const { userId, addresses } = input;

  const invalid = addresses.filter((a) => !SUPPORTED_CHAINS.includes(a.chain));
  if (invalid.length > 0) {
    throw new Error(
      `Unsupported chain(s): ${invalid.map((a) => a.chain).join(', ')}`
    );
  }

  const missing = SUPPORTED_CHAINS.filter(
    (chain) => !addresses.some((a) => a.chain === chain)
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing address(es) for required chain(s): ${missing.join(', ')}`
    );
  }

  const results = await prisma.$transaction(
    addresses.map(({ chain, address }) =>
      prisma.wallet.upsert({
        where: {
          userId_chain: {
            userId,
            chain: chain as Chain,
          }, // requires @@unique([userId, chain]) on Wallet model
        },
        update: { address },
        create: { userId, chain: chain as Chain, address },
      })
    )
  );

  return {
    registered: results.map((w) => ({ chain: w.chain as ChainId, address: w.address })),
  };
}
