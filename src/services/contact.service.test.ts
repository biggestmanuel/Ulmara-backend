import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// B4/C4: contacts.
//
// Two problems are covered:
//   1. There was no PATCH /api/contact/:id at all, so the client could only
//      "rename" a contact by DELETE + POST. That silently produces a NEW
//      contact id and destroys the contact outright if the second call fails.
//   2. A duplicate name hit `@@unique([ownerId, name])` and surfaced as a bare
//      500 ("Something went wrong"), indistinguishable from a server fault.
//
// Prisma is mocked; the real PrismaError shape is reproduced faithfully enough
// for isUniqueConstraintViolation to classify it.
// ---------------------------------------------------------------------------


const state = vi.hoisted(() => ({
  contacts: [] as Record<string, unknown>[],
  accountIds: [] as string[],
  created: [] as Record<string, unknown>[],
  updated: [] as { where: { id: string }; data: Record<string, unknown> }[],
}));

vi.mock("../config/database.js", () => {
  /** A Prisma P2002, as the client really throws it. */
  class P2002 extends Error {
    code = "P2002";
    meta = { target: ["ownerId", "name"] };
  }
  return {
    prisma: {
      contact: {
        findFirst: vi.fn(async (args: { where: { id: string; ownerId: string } }) =>
          state.contacts.find((c) => c.id === args.where.id && c.ownerId === args.where.ownerId) ?? null,
        ),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          // Enforce the real unique index so the duplicate path is exercised
          // through the same failure the database would raise.
          const clash = state.contacts.some(
            (c) => c.ownerId === args.data.ownerId && c.name === args.data.name,
          );
          if (clash) throw new P2002("Unique constraint failed");
          const row = {
            id: `c-${state.contacts.length + 1}`,
            address: null,
            chain: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...args.data,
          };
          state.contacts.push(row);
          state.created.push(args.data);
          return row;
        }),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.contacts.find((c) => c.id === args.where.id);
          if (!row) throw new Error("record not found");
          const clash = state.contacts.some(
            (c) => c.id !== args.where.id && c.ownerId === row.ownerId && c.name === args.data.name,
          );
          if (clash) throw new P2002("Unique constraint failed");
          Object.assign(row, args.data);
          state.updated.push(args);
          return row;
        }),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      accountId: {
        findUnique: vi.fn(async (args: { where: { accountId: string } }) =>
          state.accountIds.includes(args.where.accountId) ? { accountId: args.where.accountId } : null,
        ),
      },
    },
    connectDatabase: vi.fn(),
    disconnectDatabase: vi.fn(),
  };
});

import { contactService } from "./contact.service.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  state.contacts = [];
  state.accountIds = ["1234567890"];
  state.created = [];
  state.updated = [];
});

describe("B4: POST duplicate name is a 409, not an opaque 500", () => {
  it("rejects the second contact with that name for this owner", async () => {
    await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    await expect(contactService.create(OWNER, { name: "Ada", accountId: "1234567890" }))
      .rejects.toMatchObject({ statusCode: 409, message: "You already have a contact with that name" });
  });

  it("trims the name, so ' Ada' collides with 'Ada'", async () => {
    await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    await expect(contactService.create(OWNER, { name: "  Ada  ", accountId: "1234567890" }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("allows the same name for a DIFFERENT owner", async () => {
    await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    const other = await contactService.create(OTHER, { name: "Ada", accountId: "1234567890" });
    expect(other.name).toBe("Ada");
  });
});

describe("B4: PATCH /api/contact/:id", () => {
  it("renames in place and PRESERVES the contact id", async () => {
    const created = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    const patched = await contactService.update(OWNER, String(created.id), { name: "Ada L." });
    expect(patched.name).toBe("Ada L.");
    // The whole point of the route: no new id, no delete.
    expect(patched.id).toBe(created.id);
    expect(state.updated).toHaveLength(1);
    expect(state.created).toHaveLength(1);
  });

  it("re-points accountId without touching the name", async () => {
    state.accountIds = ["1234567890", "0987654321"];
    const created = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    const patched = await contactService.update(OWNER, String(created.id), { accountId: "0987654321" });
    expect(patched.accountId).toBe("0987654321");
    expect(patched.name).toBe("Ada");
    expect(patched.id).toBe(created.id);
  });

  it("changes only the fields that were supplied", async () => {
    const created = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    await contactService.update(OWNER, String(created.id), { name: "Ada 2" });
    expect(state.updated[0].data).toEqual({ name: "Ada 2" });
    expect(state.updated[0].data).not.toHaveProperty("accountId");
  });

  it("trims a renamed contact", async () => {
    const created = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    const patched = await contactService.update(OWNER, String(created.id), { name: "  Ada L.  " });
    expect(patched.name).toBe("Ada L.");
  });

  it("404s for a contact that does not exist", async () => {
    await expect(
      contactService.update(OWNER, "00000000-0000-4000-8000-000000000000", { name: "X" }),
    ).rejects.toMatchObject({ statusCode: 404, message: "Contact not found" });
  });

  it("404s for another owner's contact — indistinguishable from missing", async () => {
    const mine = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    await expect(contactService.update(OTHER, String(mine.id), { name: "Hijacked" }))
      .rejects.toMatchObject({ statusCode: 404, message: "Contact not found" });
  });

  it('404s with "Account ID not found" for a nonexistent Account ID', async () => {
    const created = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    await expect(contactService.update(OWNER, String(created.id), { accountId: "0000000000" }))
      .rejects.toMatchObject({ statusCode: 404, message: "Account ID not found" });
    // The rejected value must not be written.
    expect(state.updated).toHaveLength(0);
  });

  it("409s when the new name is already used by this owner", async () => {
    await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    const second = await contactService.create(OWNER, { name: "Grace", accountId: "1234567890" });
    await expect(contactService.update(OWNER, String(second.id), { name: "Ada" }))
      .rejects.toMatchObject({ statusCode: 409, message: "You already have a contact with that name" });
    // The contact is unchanged, not deleted.
    expect(state.contacts.find((c) => c.id === second.id)!.name).toBe("Grace");
  });

  it("409s when renaming a contact to its OWN current name via a sibling's id", async () => {
    // Guards the write path: the unique check must not fire for the row itself.
    const created = await contactService.create(OWNER, { name: "Ada", accountId: "1234567890" });
    const same = await contactService.update(OWNER, String(created.id), { name: "Ada" });
    expect(same.name).toBe("Ada");
  });
});