import { prisma } from "../config/database.js";
import { isUniqueConstraintViolation } from "../utils/prismaError.js";
import type { ChainName } from "../chains/index.js";

/** The shared 409 for a name already used by this owner. */
const DUPLICATE_NAME = "You already have a contact with that name";

/**
 * Confirms an Account ID exists before it is stored against a contact, so a
 * contact never points at an id that cannot be resolved later.
 */
async function assertAccountIdExists(accountId: string): Promise<void> {
  const account = await prisma.accountId.findUnique({ where: { accountId } });
  if (!account) throw Object.assign(new Error("Account ID not found"), { statusCode: 404 });
}

export const contactService = {
  async list(ownerId: string) {
    return prisma.contact.findMany({ where: { ownerId }, orderBy: { name: "asc" } });
  },

  async create(ownerId: string, input: { name: string; accountId?: string; address?: string; chain?: ChainName }) {
    if (!input.accountId && !input.address) throw Object.assign(new Error("accountId or address is required"), { statusCode: 400 });
    if (input.accountId) await assertAccountIdExists(input.accountId);
    try {
      return await prisma.contact.create({ data: { ownerId, name: input.name.trim(), accountId: input.accountId, address: input.address, chain: input.chain } });
    } catch (err) {
      // The `@@unique([ownerId, name])` index made a duplicate name a P2002,
      // which the controller mapped to a bare 500 ("Something went wrong"), so
      // the user could not tell a duplicate name from a server fault. C4
      // requires 409 with a message that says what happened.
      if (isUniqueConstraintViolation(err)) {
        throw Object.assign(new Error(DUPLICATE_NAME), { statusCode: 409 });
      }
      throw err;
    }
  },

  /**
   * C4: rename or re-point an existing contact IN PLACE.
   *
   * The contact id is preserved, which is the whole reason this route exists:
   * the client previously had to work around the missing PATCH by issuing
   * DELETE followed by POST, so every rename silently produced a NEW id and
   * lost the contact outright if the second call failed.
   */
  async update(ownerId: string, id: string, input: { name?: string; accountId?: string }) {
    // Scoped by ownerId, so another user's contact is indistinguishable from a
    // missing one — which is deliberate: a 403 here would confirm the id exists.
    const existing = await prisma.contact.findFirst({ where: { id, ownerId } });
    if (!existing) throw Object.assign(new Error("Contact not found"), { statusCode: 404 });

    if (input.accountId !== undefined) await assertAccountIdExists(input.accountId);

    try {
      return await prisma.contact.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw Object.assign(new Error(DUPLICATE_NAME), { statusCode: 409 });
      }
      throw err;
    }
  },

  async remove(ownerId: string, id: string) {
    const result = await prisma.contact.deleteMany({ where: { id, ownerId } });
    if (!result.count) throw Object.assign(new Error("Contact not found"), { statusCode: 404 });
    return { deleted: true };
  },
};
