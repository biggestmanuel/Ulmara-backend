import { prisma } from "../config/database.js";
import type { ChainName } from "../chains/index.js";

export const contactService = {
  async list(ownerId: string) {
    return prisma.contact.findMany({ where: { ownerId }, orderBy: { name: "asc" } });
  },
  async create(ownerId: string, input: { name: string; accountId?: string; address?: string; chain?: ChainName }) {
    if (!input.accountId && !input.address) throw Object.assign(new Error("accountId or address is required"), { statusCode: 400 });
    if (input.accountId) {
      const account = await prisma.accountId.findUnique({ where: { accountId: input.accountId } });
      if (!account) throw Object.assign(new Error("Account ID not found"), { statusCode: 404 });
    }
    return prisma.contact.create({ data: { ownerId, name: input.name.trim(), accountId: input.accountId, address: input.address, chain: input.chain } });
  },
  async remove(ownerId: string, id: string) {
    const result = await prisma.contact.deleteMany({ where: { id, ownerId } });
    if (!result.count) throw Object.assign(new Error("Contact not found"), { statusCode: 404 });
    return { deleted: true };
  },
};
