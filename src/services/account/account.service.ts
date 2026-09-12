import { prisma } from "../../config/database.js";
import { generateAccountId } from "../../utils/generateAccountId.js";

export const accountService = {
  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { accountId: true },
    });
    if (!user) throw Object.assign(new Error("User not found"), { statusCode: 404 });
    const { passwordHash, pinHash, ...safe } = user;
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
    throw Object.assign(new Error("Could not generate a unique Account ID, try again"), {
      statusCode: 500,
    });

    // NOTE: this does NOT create Wallet rows for the 7 chains. Doing that safely
    // requires a real key-generation/custody design (HD wallet derivation + secure
    // key storage) which hasn't been decided yet — see chat notes.
  },

  async getByAccountId(accountId: string) {
    const record = await prisma.accountId.findUnique({
      where: { accountId },
      include: { user: { select: { id: true, name: true, photoUrl: true, wallets: { select: { chain: true, address: true } } } } },
    });
    if (!record) throw Object.assign(new Error("Account ID not found"), { statusCode: 404 });
    return { accountId: record.accountId, profile: record.user };
  },

  async updateSettings(
    userId: string,
    input: Partial<{
      name: string;
      photoUrl: string;
      defaultCurrency: string;
      defaultLanguage: string;
      defaultNetwork: string;
    }>
  ) {
    return prisma.user.update({ where: { id: userId }, data: input as any });
  },
};
