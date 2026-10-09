import { prisma } from "../../config/database.js";
import { generateAccountId } from "../../utils/generateAccountId.js";
import { HttpError } from "../../utils/apiResponse.js";
import type { Chain } from "@prisma/client";

export const accountService = {
  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { accountId: true },
    });
    if (!user) throw Object.assign(new Error("User not found"), { statusCode: 404 });
    // `_`-prefixed so the deliberate omission of the credential columns is
    // explicit at the destructuring site rather than looking like a dead read.
    const { passwordHash: _passwordHash, pinHash: _pinHash, ...safe } = user;
    return safe;
  },

  async createAccountId(userId: string) {
    const existing = await prisma.accountId.findUnique({ where: { userId } });
    if (existing) {
      throw Object.assign(new Error("Account ID already created"), { statusCode: 409 });
    }

    // Retry on collision — 10-digit space is large but not infinite
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateAccountId();
      const taken = await prisma.accountId.findUnique({ where: { accountId: candidate } });
      if (!taken) {
        return prisma.accountId.create({ data: { accountId: candidate, userId } });
      }
    }
    // User-safe copy, so it is an HttpError: handleError surfaces a 5xx message
    // only for that class, and this one tells the caller to retry rather than
    // leaving them with "Something went wrong".
    throw new HttpError(500, "Could not generate a unique Account ID, try again");

    // This deliberately creates NO Wallet rows. Ulmara is non-custodial and that
    // decision is made and implemented, not pending: the client generates every
    // key on the device (`lib/keyGeneration.ts` in avora-frontend — bip39
    // mnemonics, one derivation path per chain), signs on the device
    // (`lib/signing/`), and stores the phrases in the device keystore. It then
    // registers the PUBLIC addresses here via `POST /api/wallet/register`, and
    // those are the only address strings this service ever sees.
    //
    // This comment previously said the custody design "hasn't been decided yet".
    // It had been, and leaving the stale wording in place was a live hazard: a
    // reader could reasonably conclude that generating wallets server-side was
    // an open question, and implement it. Server-side key custody would invert
    // the product's core promise, put every user's funds behind this service,
    // and put a seed phrase in a database and a log pipeline. **Never generate,
    // request, receive, store, log or forward a private key or mnemonic here.**
    // The outbound half is enforced too: `wallet.service.ts` documents the same
    // rule, and `config/sentry.ts` scrubs `mnemonic`/`privateKey`/`seed` from any
    // captured payload.
    //
    // Transfers keep keys on the device by construction, not by convention:
    // `POST /api/transaction/external/prepare` persists an intent and returns
    // nothing that can sign, and `/:id/submit` takes an already-signed
    // transaction and verifies it against the stored intent. There is no code
    // path from this service to a signature.
  },

  async getByAccountId(accountId: string) {
    const record = await prisma.accountId.findUnique({
      where: { accountId },
      include: { user: { select: { id: true, name: true, photoUrl: true, wallets: { select: { chain: true } } } } },
    });
    if (!record) throw Object.assign(new Error("Account ID not found"), { statusCode: 404 });
    return { accountId: record.accountId, profile: record.user };
  },

  async resolveForTransfer(requestingUserId: string, accountId: string) {
    const record = await prisma.accountId.findUnique({
      where: { accountId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            photoUrl: true,
            wallets: { select: { chain: true, address: true } },
          },
        },
      },
    });
    if (!record) throw Object.assign(new Error("Account ID not found"), { statusCode: 404 });
    if (record.userId === requestingUserId) {
      throw Object.assign(new Error("Cannot resolve your own Account ID for transfer"), { statusCode: 400 });
    }
    return {
      accountId: record.accountId,
      profile: record.user,
    };
  },

  async updateSettings(
    userId: string,
    // `null` is a real instruction, not "absent": the schema uses
    // `.nullable().optional()` so a client can clear a nullable column back to
    // NULL. Omitting a key leaves it untouched, because Prisma only writes the
    // keys actually present in `data`.
    input: Partial<{
      name: string | null;
      photoUrl: string | null;
      defaultCurrency: string;
      defaultLanguage: string;
      defaultNetwork: Chain | null;
    }>
  ) {
    return prisma.user.update({
      where: { id: userId },
      data: input,
      select: {
        id: true, email: true, phone: true, name: true, photoUrl: true,
        emailVerified: true, phoneVerified: true, biometricEnabled: true,
        twoFactorEnabled: true, defaultCurrency: true, defaultLanguage: true,
        defaultNetwork: true, createdAt: true, updatedAt: true,
      },
    });
  },
};
